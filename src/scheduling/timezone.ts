/**
 * ADR 026 follow-up 2 (issue #31): the zone arithmetic a cron expression needs to
 * be evaluated in a project's own timezone rather than in UTC.
 *
 * **Kept pure and dependency-free, like `cron.ts`.** The only tool used is
 * `Intl.DateTimeFormat` with a `timeZone` option, which Node ships: no timezone
 * database to maintain, and — importantly here — **no runtime dependency**, which
 * the build environment cannot add (see `docs/roadmap/burn-down-handoff.md`).
 * Hand-rolling a tz database would be a liability; hand-rolling the *offset
 * lookup* against the platform's own is not, and that is all this is.
 *
 * **The distinction this module exists to make.** A fixed offset is the trap
 * ADR 026 named: storing `+05:30` and applying it year-round reproduces exactly
 * the bug the issue complains about, because "every night at 2am" then drifts by
 * an hour when the zone's offset changes. So nothing here stores or accepts an
 * offset — it resolves a *wall time* to an instant **in a named zone**, per
 * occurrence, which is what keeps 2am at 2am through both transitions.
 *
 * Everything is in terms of wall-clock parts (`year`/`month`/`day`/`hour`/
 * `minute` in the zone) rather than UTC parts, because that is the only frame in
 * which "the second Tuesday at 09:00" means anything.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The wall-clock parts of an instant, as read in a zone. */
export interface WallClock {
  year: number;
  month: number;
  /** 1-based, to match cron's own numbering and `projects.settings`' intent. */
  day: number;
  hour: number;
  minute: number;
}

/**
 * `Intl.DateTimeFormat` construction is the expensive part of a zone lookup, and
 * a single `previousOccurrenceInTimeZone` call formats every candidate on every
 * matching day. Cached per zone because the set of zones is tiny and bounded by
 * how many projects exist, and keyed on the canonical name so a case variant
 * (`america/new_york`) shares the entry — `Intl` accepts it, so a cache keyed on
 * the raw string would silently miss.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let existing = formatters.get(timeZone);
  if (!existing) {
    existing = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // `h23` explicitly: with `hour12: false` some ICU versions render midnight
      // as hour "24", which would put every midnight schedule on the previous
      // day's last hour and silently shift it by an hour.
      hourCycle: "h23",
    });
    formatters.set(timeZone, existing);
  }
  return existing;
}

/**
 * Whether a string is a zone this runtime can actually resolve.
 *
 * Used to validate a *stored* setting, so a typo is rejected on write. It cannot
 * be relied on forever, though — the set of zones comes from the runtime's own
 * tz database and can differ between Node versions or deploys — which is why
 * readers also tolerate an invalid value rather than trusting this check
 * (see `timeZoneOrUtc`).
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * The zone to actually evaluate in: the stored one when it resolves, `"UTC"`
 * otherwise.
 *
 * **Tolerating a bad value is the point.** A stored zone that this runtime cannot
 * resolve must not wedge the scheduler — it would throw inside the tick, abandon
 * the whole candidate pass, and stop *every* project's tests from running because
 * one project's setting is wrong. Falling back to UTC degrades one project to the
 * pre-#31 behaviour, which is exactly what every project does today.
 *
 * Returns `"UTC"` for anything unusable, so callers never have to branch and the
 * UTC path keeps its own well-tested code.
 */
export function timeZoneOrUtc(stored: string | null | undefined): string {
  if (stored && isValidTimeZone(stored)) return stored;
  return "UTC";
}

/** Whether a stored zone had to be rejected, so a caller can log it once. */
export function isFallingBackToUtc(stored: string | null | undefined): boolean {
  return Boolean(stored) && !isValidTimeZone(stored as string);
}

/** The wall-clock parts of `instant`, as read in `timeZone`. */
export function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = formatter(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
  };
}

/**
 * A zone's offset from UTC at a given instant, in milliseconds (east positive).
 *
 * Derived rather than looked up: format the instant in the zone, reinterpret
 * those wall-clock parts as though they were UTC, and the difference *is* the
 * offset. That is correct for any instant, including one inside a DST transition,
 * because the formatting is the platform's own answer for that exact moment.
 *
 * Milliseconds are stripped before differencing because `formatToParts` resolves
 * only to seconds — leaving them in would fold the instant's own sub-second
 * remainder into the offset and make it wrong by up to 999ms.
 */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = wallClock(instant, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}

/**
 * What resolving a wall time in a zone produced.
 *
 * Three outcomes, not two, because a naive "convert wall time to instant" is
 * wrong twice a year in two *different* ways and each needs a deliberate answer:
 *
 * - `exact` — the ordinary case, and also a fall-back wall time that the caller
 *   has chosen to pin (see `ambiguous`).
 * - `ambiguous` — a fall-back wall time that happens **twice**, with `instant`
 *   set to the **earlier** of the two. ADR 026 chose earlier deliberately: the run
 *   happens at the first occurrence rather than an hour late for a reason the user
 *   did not ask for.
 * - `nonexistent` — a spring-forward wall time that **never happens**. ADR 026
 *   chose to **skip it**: the run happens on the other 364 days and the strict-`>`
 *   catch-up self-heals at the next occurrence, whereas shifting to 03:30 would
 *   invent a time the user did not ask for. (Vixie cron shifts; GitHub Actions and
 *   Vercel skip. Skipping is the one that does not silently change what was
 *   configured.)
 *
 * The threshold is inclusive of `exact` and `ambiguous` both being *usable* — the
 * caller decides what to do with the ambiguity, since skipping it would be the
 * wrong reading of "take the earlier".
 */
export type WallTimeResolution =
  | { kind: "exact"; instant: Date }
  | { kind: "ambiguous"; instant: Date }
  | { kind: "nonexistent" };

/**
 * Resolves a wall time in a zone to the instant(s) it names.
 *
 * **Why two candidate offsets rather than one.** The instant we want satisfies
 * `wallClock(instant) === target`, and the offset needed to get there depends on
 * the instant — which is the circularity that makes DST hard. So the offsets
 * *around* the target are sampled (a day either side, which brackets any
 * transition) and each produces a candidate; asking the platform which of them
 * actually reads back as the target settles it. A single-offset guess would be
 * wrong for exactly the transition hours this exists to get right.
 *
 * A wall time that no candidate reproduces is `nonexistent`, and one that *both*
 * reproduce is `ambiguous` — that is the spring-forward and fall-back cases
 * respectively, detected rather than assumed from the date.
 */
export function resolveWallTime(
  wall: WallClock,
  timeZone: string,
): WallTimeResolution {
  const asUtcMs = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);

  // Offsets a day either side: any DST transition moves the offset by at most a
  // couple of hours, so these bracket whichever offset the target actually lands
  // under regardless of which side of the transition it falls on.
  const offsetBefore = zoneOffsetMs(new Date(asUtcMs - DAY_MS), timeZone);
  const offsetAfter = zoneOffsetMs(new Date(asUtcMs + DAY_MS), timeZone);

  const before = new Date(asUtcMs - offsetBefore);
  const after = new Date(asUtcMs - offsetAfter);

  const beforeMatches = sameWallClock(before, wall, timeZone);
  const afterMatches = sameWallClock(after, wall, timeZone);

  if (beforeMatches && afterMatches) {
    // A wall time both candidate offsets reproduce is one that occurs twice, so
    // the earlier instant is the one the run should use.
    if (before.getTime() === after.getTime()) return { kind: "exact", instant: before };
    const earlier = before.getTime() < after.getTime() ? before : after;
    return { kind: "ambiguous", instant: earlier };
  }
  if (beforeMatches) return { kind: "exact", instant: before };
  if (afterMatches) return { kind: "exact", instant: after };
  return { kind: "nonexistent" };
}

function sameWallClock(instant: Date, wall: WallClock, timeZone: string): boolean {
  const actual = wallClock(instant, timeZone);
  return (
    actual.year === wall.year &&
    actual.month === wall.month &&
    actual.day === wall.day &&
    actual.hour === wall.hour &&
    actual.minute === wall.minute
  );
}

/**
 * Steps a wall-clock date by whole **local** calendar days.
 *
 * Local calendar days are 23 or 25 hours across a transition, so a lookback must
 * not step by a fixed 24-hour increment — that is the assumption the UTC-only
 * implementation gets away with and a zone-aware one cannot. Because this works
 * on `year`/`month`/`day` parts rather than on an instant, the arithmetic is pure
 * calendar arithmetic and the day length never enters it.
 */
export function addWallClockDays(wall: WallClock, days: number): WallClock {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: wall.hour,
    minute: wall.minute,
  };
}

/**
 * The weekday (0 = Sunday) of a **calendar date**, independent of any zone.
 *
 * Built through `Date.UTC` on purpose: a UTC-constructed date has no DST, so its
 * `getUTCDay()` is the true weekday of that calendar date. Reading the weekday off
 * an instant instead would give a different answer either side of midnight, which
 * is precisely the off-by-one-day bug a zoned day-of-week match would otherwise
 * introduce.
 */
export function calendarWeekday(wall: Pick<WallClock, "year" | "month" | "day">): number {
  return new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
}

/** The calendar date (no time) of `instant`, as read in `timeZone`. */
export function calendarDateIn(
  instant: Date,
  timeZone: string,
): Pick<WallClock, "year" | "month" | "day"> {
  const parts = wallClock(instant, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}
