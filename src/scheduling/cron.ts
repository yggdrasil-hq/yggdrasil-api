/**
 * ADR 026: pure cron evaluation for the test-run scheduler.
 *
 * Deliberately dependency-free and pure — no database, no clock of its own, no
 * process state. A scheduler is exactly where off-by-one and boundary bugs
 * hide, so every decision the scheduler makes about "is this test due" is
 * computed here and unit-tested exhaustively in `cron.test.ts`, rather than
 * being entangled with the claim/dispatch transaction in `scheduler.ts`.
 *
 * **Schedules are evaluated in UTC unless a project names a zone** (issue #31).
 * `previousOccurrence` below stays UTC-only and pure — it is the fallback, and
 * its tests are the ones the zone-aware path defers to for `"UTC"` — while
 * `previousOccurrenceInTimeZone` walks *local calendar days* for a project that
 * has set one. The documented consequence for every project that has not is
 * unchanged: `TEST_SCHEDULE_PRESETS.daily9am` means 09:00 **UTC**.
 *
 * **Why a named zone rather than a stored offset.** An offset is the trap ADR 026
 * named: `+05:30` applied year-round reproduces the drift the issue complains
 * about, because "every night at 2am" moves when the zone's own offset changes.
 * A zone name lets each occurrence be resolved in that zone, so 2am stays 2am
 * through both transitions. See `timezone.ts` for the resolution and its DST
 * answers.
 *
 * Supported syntax is the classic 5-field Vixie subset the product actually
 * accepts (`isValidCronExpression` in `tests/types.ts` only checks that there
 * are five non-empty fields, so this parser is the real gate): a wildcard, a
 * bare value, a range, any of those with a step, and comma-separated lists of
 * those elements. Numeric only — no `jan`/`mon` names, no `@daily` aliases, no
 * seconds field.
 */

import {
  addWallClockDays,
  calendarDateIn,
  resolveWallTime,
  timeZoneOrUtc,
} from "./timezone.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How far back `previousOccurrence` will look for a match. Comfortably more
 * than a year, so every schedule that fires at least annually is found. A
 * schedule that matches less often than that (e.g. `0 0 29 2 1`, Feb 29 *and*
 * a Monday) simply reports no occurrence, and the test is never due — a
 * fail-safe outcome: an unfireable schedule dispatches nothing rather than
 * dispatching wrongly.
 */
export const MAX_LOOKBACK_DAYS = 400;

export interface CronFields {
  minutes: number[];
  hours: number[];
  /** Descending, so `previousOccurrence` can scan latest-first without re-sorting. */
  minutesDesc: number[];
  hoursDesc: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** `true` when the raw field was not literally `*` — see `dayMatches`. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

/**
 * Parses one cron field into the set of values it matches.
 *
 * `a/n` (a step with no range) means `a`-through-`max` stepped by `n`, which is
 * Vixie's behaviour rather than a special case — `5/15` in the minutes field is
 * the same as `5-59/15`.
 *
 * Returns null for anything malformed (empty element, non-numeric, out of
 * range, inverted range, zero step), so a caller can treat "unparseable" and
 * "matches nothing" as the same, safe outcome.
 */
function parseField(spec: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();

  const elements = spec.split(",");
  if (elements.length === 0) return null;

  for (const element of elements) {
    if (element === "") return null;

    const slashParts = element.split("/");
    if (slashParts.length > 2) return null;
    const [rangePart, stepPart] = slashParts;

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1) return null;
    }

    let low: number;
    let high: number;

    if (rangePart === "*") {
      low = min;
      high = max;
    } else if (rangePart.includes("-")) {
      const match = /^(\d+)-(\d+)$/.exec(rangePart);
      if (!match) return null;
      low = Number(match[1]);
      high = Number(match[2]);
    } else {
      if (!/^\d+$/.test(rangePart)) return null;
      low = Number(rangePart);
      // A bare value with a step is a range to the field's maximum; a bare
      // value without one is exactly that value.
      high = stepPart === undefined ? low : max;
    }

    if (low < min || high > max || low > high) return null;
    for (let value = low; value <= high; value += step) {
      values.add(value);
    }
  }

  return values;
}

/** Parses a 5-field expression, or returns null if it is malformed. */
export function parseCron(expression: string): CronFields | null {
  const parts = String(expression ?? "").trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteSpec, hourSpec, dayOfMonthSpec, monthSpec, dayOfWeekSpec] = parts;

  const minutes = parseField(minuteSpec, 0, 59);
  const hours = parseField(hourSpec, 0, 23);
  const daysOfMonth = parseField(dayOfMonthSpec, 1, 31);
  const months = parseField(monthSpec, 1, 12);
  const rawDaysOfWeek = parseField(dayOfWeekSpec, 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDaysOfWeek) return null;

  // 0 and 7 both mean Sunday; normalise onto 0 so `getUTCDay()` can be
  // compared directly.
  const daysOfWeek = new Set<number>();
  for (const value of rawDaysOfWeek) {
    daysOfWeek.add(value === 7 ? 0 : value);
  }

  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    minutesDesc: [...minutes].sort((a, b) => b - a),
    hoursDesc: [...hours].sort((a, b) => b - a),
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: dayOfMonthSpec !== "*",
    dayOfWeekRestricted: dayOfWeekSpec !== "*",
  };
}

/**
 * The day-of-month / day-of-week rule, kept separate because cron's is the
 * surprising one: when *both* fields are restricted a day matches if **either**
 * matches (Vixie's OR), whereas when only one is restricted it must match.
 *
 * "Restricted" is the literal wildcard test, matching Vixie and the common
 * cron libraries: a stepped wildcard in the day-of-month field counts as
 * restricted, so it takes part in the OR. Documented rather than assumed,
 * since libraries differ here.
 */
function dayMatches(fields: CronFields, day: Date): boolean {
  const domMatch = fields.daysOfMonth.has(day.getUTCDate());
  const dowMatch = fields.daysOfWeek.has(day.getUTCDay());

  if (!fields.dayOfMonthRestricted && !fields.dayOfWeekRestricted) return true;
  if (fields.dayOfMonthRestricted && !fields.dayOfWeekRestricted) return domMatch;
  if (!fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return dowMatch;
  return domMatch || dowMatch;
}

/**
 * The most recent instant **at or before** `at` that `expression` matches,
 * evaluated in UTC, or null when there is none within `MAX_LOOKBACK_DAYS`.
 *
 * Walks day by day backwards and, only on days that actually match month and
 * day, scans the matching hours/minutes latest-first. That keeps the cost at
 * ~400 cheap date checks rather than a minute-by-minute scan of the same span,
 * which matters because this runs per candidate test on every tick.
 *
 * Inclusive (`<= at`) on purpose: it makes the due-check's strict `>` against
 * the reference time decide the boundary, in one place, instead of splitting
 * the boundary decision across two functions.
 */
export function previousOccurrence(
  expression: string,
  at: Date,
  maxLookbackDays: number = MAX_LOOKBACK_DAYS,
): Date | null {
  const fields = parseCron(expression);
  if (!fields) return null;

  const atMs = at.getTime();
  if (Number.isNaN(atMs)) return null;

  const startOfDayMs = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
  );

  for (let offset = 0; offset <= maxLookbackDays; offset += 1) {
    const dayStartMs = startOfDayMs - offset * DAY_MS;
    const day = new Date(dayStartMs);

    if (!fields.months.has(day.getUTCMonth() + 1)) continue;
    if (!dayMatches(fields, day)) continue;

    // Today can only be scanned up to `at`; any earlier day, to its last minute.
    const upperMs = offset === 0 ? atMs : dayStartMs + DAY_MS - MINUTE_MS;

    for (const hour of fields.hoursDesc) {
      for (const minute of fields.minutesDesc) {
        const candidateMs = dayStartMs + hour * HOUR_MS + minute * MINUTE_MS;
        if (candidateMs > upperMs) continue;
        return new Date(candidateMs);
      }
    }
  }

  return null;
}

/**
 * The most recent instant **at or before** `at` that `expression` matches,
 * evaluated in `timeZone`, or null when there is none within
 * `MAX_LOOKBACK_DAYS`.
 *
 * **`"UTC"` delegates to `previousOccurrence` above**, deliberately: UTC is the
 * pre-#31 behaviour for every project that has not set a zone, and routing it
 * through the (slower) local-day walk would mean the common path no longer
 * exercises the code its exhaustive tests cover. One implementation per frame of
 * reference, and the UTC one is the one with the tests.
 *
 * **The walk is over local calendar days, not 24-hour steps.** A local day is 23
 * or 25 hours across a transition, so stepping by `DAY_MS` from a fixed origin
 * would drift by an hour on one side of it — the assumption the UTC-only version
 * is entitled to make and this one is not.
 *
 * **Matching happens on the local calendar date**, so "the second Tuesday at
 * 09:00" means that locally. `dayMatches` is reused by handing it a date built
 * through `Date.UTC` from the local date parts: a UTC-constructed date has no DST
 * hook, so its `getUTCDay()` is that calendar date's true weekday regardless of
 * the zone.
 *
 * **A wall time that does not exist is skipped**, per ADR 026: a daily suite
 * misses one run on the forward-transition day and self-heals at the next
 * occurrence, rather than the run being silently moved to a time nobody asked
 * for. An ambiguous (fall-back) wall time takes the earlier instant.
 */
export function previousOccurrenceInTimeZone(
  expression: string,
  at: Date,
  timeZone: string,
  maxLookbackDays: number = MAX_LOOKBACK_DAYS,
): Date | null {
  const fields = parseCron(expression);
  if (!fields) return null;

  const atMs = at.getTime();
  if (Number.isNaN(atMs)) return null;

  const zone = timeZoneOrUtc(timeZone);
  if (zone === "UTC") return previousOccurrence(expression, at, maxLookbackDays);

  const startDate = calendarDateIn(at, zone);

  for (let offset = 0; offset <= maxLookbackDays; offset += 1) {
    const date = addWallClockDays({ ...startDate, hour: 0, minute: 0 }, -offset);

    if (!fields.months.has(date.month)) continue;
    if (!dayMatches(fields, utcDateForCalendar(date))) continue;

    // Latest candidate first, so an earlier day returns on its first resolution.
    // "Today" is the only day that can scan the whole grid, because only there is
    // `atMs` an upper bound; on any earlier day the first candidate is the answer.
    for (const hour of fields.hoursDesc) {
      for (const minute of fields.minutesDesc) {
        const resolved = resolveWallTime({ ...date, hour, minute }, zone);

        // Spring forward: this wall time does not happen today. Skipping the
        // candidate is ADR 026's answer, and it must not abort the day — a
        // different hour on the same day may well be valid.
        if (resolved.kind === "nonexistent") continue;

        const instantMs = resolved.instant.getTime();
        if (instantMs > atMs) continue;
        return resolved.instant;
      }
    }
  }

  return null;
}

/** A `Date` whose UTC parts are the given calendar date, for the weekday check. */
function utcDateForCalendar(date: { year: number; month: number; day: number }): Date {
  return new Date(Date.UTC(date.year, date.month - 1, date.day));
}

/**
 * The shortest gap between two consecutive occurrences of `expression` at or
 * before `at`, in milliseconds, or null when there is not enough of a
 * schedule inside `MAX_LOOKBACK_DAYS` to measure one.
 *
 * Exists so `meetsMinimumInterval` can enforce the product's "minimum interval
 * is 1 hour" rule against the schedule the parser will actually run, rather
 * than against a pattern guess. Pattern-matching the string cannot work:
 * `* 10 * * *` and `* * * * 1` both look harmless and both fire every minute.
 *
 * Measured over `samples` consecutive occurrences rather than just the last
 * two, because a schedule's gap is not constant — `0 0 1,15 * *` has a short
 * gap in some months and a long one in others — and the rule is about the
 * *minimum* interval, so one sampled pair is not enough to see the short one.
 * The scan is bounded by `MAX_LOOKBACK_DAYS` and stops early once occurrences
 * run out, so a yearly schedule costs the same as an hourly one.
 */
export function minimumIntervalMs(
  expression: string,
  at: Date,
  samples = 4,
): number | null {
  let cursorMs = at.getTime();
  let previousMs: number | null = null;
  let minimum: number | null = null;

  for (let index = 0; index < samples; index += 1) {
    const occurrence = previousOccurrence(expression, new Date(cursorMs));
    if (!occurrence) break;

    const occurrenceMs = occurrence.getTime();
    if (previousMs !== null) {
      const gap = previousMs - occurrenceMs;
      if (minimum === null || gap < minimum) minimum = gap;
    }

    previousMs = occurrenceMs;
    // `previousOccurrence` is inclusive, so step back a minute to get the one
    // before it.
    cursorMs = occurrenceMs - MINUTE_MS;
  }

  return minimum;
}

/**
 * Whether a test's schedule has come due.
 *
 * `reference` is the last time this schedule fired, falling back to when the
 * test was created — never "the epoch", because a schedule that has not fired
 * since before it existed must not fire the moment it is created. A test added
 * at 09:30 with a daily-09:00 schedule therefore waits for tomorrow's 09:00
 * rather than running immediately, which is the behaviour an operator expects
 * ("it starts on its next window").
 *
 * The strict `>` is also what gives catch-up its shape: after an outage, the
 * most recent occurrence is still newer than the last run, so the test fires
 * **once**, not once per window missed. A test suite is a verification action,
 * not an event log — replaying six missed hours six times would burn compute
 * and say nothing the single run does not.
 *
 * The comparison is between two **instants**, so it is unaffected by the zone:
 * `previousOccurrenceInTimeZone` answers "when, in absolute time", and the
 * reference is an absolute time. Which zone the schedule was written in changes
 * *which* instant is found, never how they compare.
 */
export function isDueForSchedule(input: {
  expression: string;
  lastRunAt: Date | null;
  createdAt: Date;
  now: Date;
  /**
   * Issue #31: the project's own zone, as a stored IANA name. Optional and
   * defaulting to UTC, so every existing caller — and every project that has not
   * set one — behaves exactly as before.
   *
   * An unusable value resolves to UTC rather than throwing: a bad setting must
   * degrade one project to the old behaviour, not stop the scheduler from
   * evaluating every other project's tests (`timeZoneOrUtc`).
   */
  timeZone?: string | null;
}): boolean {
  const previous = previousOccurrenceInTimeZone(
    input.expression,
    input.now,
    input.timeZone ?? "UTC",
  );
  if (!previous) return false;
  const reference = input.lastRunAt ?? input.createdAt;
  return previous.getTime() > reference.getTime();
}
