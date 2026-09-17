/**
 * ADR 026: pure cron evaluation for the test-run scheduler.
 *
 * Deliberately dependency-free and pure — no database, no clock of its own, no
 * process state. A scheduler is exactly where off-by-one and boundary bugs
 * hide, so every decision the scheduler makes about "is this test due" is
 * computed here and unit-tested exhaustively in `cron.test.ts`, rather than
 * being entangled with the claim/dispatch transaction in `scheduler.ts`.
 *
 * **Every schedule is evaluated in UTC.** There is no per-project timezone
 * concept anywhere in the product, so inventing one here would mean guessing;
 * UTC is also the one choice that makes DST structurally impossible rather
 * than merely unlikely (a UTC day is always 86,400 seconds). The documented
 * consequence is that `TEST_SCHEDULE_PRESETS.daily9am` means 09:00 **UTC**, and
 * a per-project timezone is a follow-up, not an oversight.
 *
 * Supported syntax is the classic 5-field Vixie subset the product actually
 * accepts (`isValidCronExpression` in `tests/types.ts` only checks that there
 * are five non-empty fields, so this parser is the real gate): a wildcard, a
 * bare value, a range, any of those with a step, and comma-separated lists of
 * those elements. Numeric only — no `jan`/`mon` names, no `@daily` aliases, no
 * seconds field.
 */

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
 */
export function isDueForSchedule(input: {
  expression: string;
  lastRunAt: Date | null;
  createdAt: Date;
  now: Date;
}): boolean {
  const previous = previousOccurrence(input.expression, input.now);
  if (!previous) return false;
  const reference = input.lastRunAt ?? input.createdAt;
  return previous.getTime() > reference.getTime();
}
