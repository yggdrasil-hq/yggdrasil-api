import { describe, expect, it } from "vitest";
import {
  MAX_LOOKBACK_DAYS,
  isDueForSchedule,
  minimumIntervalMs,
  parseCron,
  previousOccurrence,
  previousOccurrenceInTimeZone,
} from "./cron.js";

/** UTC helper — every assertion in this file is in UTC, by ADR 026's design. */
function utc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

describe("parseCron — accepted syntax", () => {
  it("parses the presets the product ships", () => {
    for (const expression of [
      "0 * * * *",
      "0 */6 * * *",
      "0 9 * * *",
      "0 9 * * 1",
    ]) {
      expect(parseCron(expression), expression).not.toBeNull();
    }
  });

  it("expands wildcards to the field bounds", () => {
    const fields = parseCron("* * * * *");
    expect(fields?.minutes).toHaveLength(60);
    expect(fields?.hours).toHaveLength(24);
    expect(fields?.minutes[0]).toBe(0);
    expect(fields?.minutes[59]).toBe(59);
  });

  it("expands */n ranges", () => {
    expect(parseCron("*/15 * * * *")?.minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron("0 */6 * * *")?.hours).toEqual([0, 6, 12, 18]);
  });

  it("treats a bare value with a step as a range to the field maximum (Vixie)", () => {
    // `5/15` in minutes is `5-59/15`, not "minute 5 only".
    expect(parseCron("5/15 * * * *")?.minutes).toEqual([5, 20, 35, 50]);
  });

  it("expands bounded ranges with and without steps", () => {
    expect(parseCron("0-30/10 * * * *")?.minutes).toEqual([0, 10, 20, 30]);
    expect(parseCron("10-12 * * * *")?.minutes).toEqual([10, 11, 12]);
  });

  it("expands comma-separated lists of mixed elements", () => {
    expect(parseCron("0,30,45-50 * * * *")?.minutes).toEqual([
      0, 30, 45, 46, 47, 48, 49, 50,
    ]);
  });

  it("exposes descending copies for latest-first scanning", () => {
    const fields = parseCron("0,30 * * * *");
    expect(fields?.minutes).toEqual([0, 30]);
    expect(fields?.minutesDesc).toEqual([30, 0]);
  });

  it("normalises day-of-week 7 onto Sunday, and 0 too", () => {
    expect(parseCron("0 0 * * 7")?.daysOfWeek.has(0)).toBe(true);
    expect(parseCron("0 0 * * 0")?.daysOfWeek.has(0)).toBe(true);
    // 5-7 is Fri, Sat, Sun — Sunday must land on 0.
    expect([...parseCron("0 0 * * 5-7")!.daysOfWeek].sort()).toEqual([0, 5, 6]);
  });

  it("records which day fields were restricted, for the dom/dow OR rule", () => {
    expect(parseCron("0 0 * * *")?.dayOfMonthRestricted).toBe(false);
    expect(parseCron("0 0 * * *")?.dayOfWeekRestricted).toBe(false);
    expect(parseCron("0 0 1 * *")?.dayOfMonthRestricted).toBe(true);
    expect(parseCron("0 0 * * 1")?.dayOfWeekRestricted).toBe(true);
    // A stepped wildcard is not literally `*`, matching Vixie.
    expect(parseCron("0 0 */2 * *")?.dayOfMonthRestricted).toBe(true);
  });
});

describe("parseCron — rejected syntax", () => {
  it.each([
    ["", "empty"],
    ["0 * * *", "four fields"],
    ["0 * * * * *", "six fields"],
    ["60 * * * *", "minute out of range"],
    ["* 24 * * *", "hour out of range"],
    ["0 0 0 * *", "day-of-month below 1"],
    ["0 0 32 * *", "day-of-month above 31"],
    ["0 0 * 0 *", "month below 1"],
    ["0 0 * 13 *", "month above 12"],
    ["0 0 * * 8", "day-of-week above 7"],
    ["*/0 * * * *", "zero step"],
    ["5-2 * * * *", "inverted range"],
    ["1-70 * * * *", "range exceeding the field"],
    ["a * * * *", "non-numeric"],
    ["1- * * * *", "dangling range"],
    ["1/ * * * *", "dangling step"],
    ["0 0 * * 1,,2", "empty list element"],
    ["*/2/3 * * * *", "double step"],
    ["@daily", "alias"],
    ["0 0 * * MON", "names"],
  ])("rejects %s (%s)", (expression) => {
    expect(parseCron(expression)).toBeNull();
  });
});

describe("previousOccurrence", () => {
  it("finds the latest matching minute within the hour", () => {
    const previous = previousOccurrence("*/15 * * * *", utc(2026, 9, 17, 10, 37));
    expect(previous?.toISOString()).toBe("2026-09-17T10:30:00.000Z");
  });

  it("is inclusive of the exact instant asked for", () => {
    const previous = previousOccurrence("0 * * * *", utc(2026, 9, 17, 10, 0));
    expect(previous?.toISOString()).toBe("2026-09-17T10:00:00.000Z");
  });

  it("returns the current hour once the hour has started", () => {
    const previous = previousOccurrence("0 * * * *", utc(2026, 9, 17, 10, 30));
    expect(previous?.toISOString()).toBe("2026-09-17T10:00:00.000Z");
  });

  it("falls back to the previous day when today's time has not arrived", () => {
    const previous = previousOccurrence("0 9 * * *", utc(2026, 9, 17, 8, 0));
    expect(previous?.toISOString()).toBe("2026-09-16T09:00:00.000Z");
  });

  it("returns today's time once it has arrived", () => {
    const previous = previousOccurrence("0 9 * * *", utc(2026, 9, 17, 9, 0));
    expect(previous?.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    const later = previousOccurrence("0 9 * * *", utc(2026, 9, 17, 23, 59));
    expect(later?.toISOString()).toBe("2026-09-17T09:00:00.000Z");
  });

  it("honours a restricted day-of-month", () => {
    const previous = previousOccurrence("0 0 1 * *", utc(2026, 9, 17));
    expect(previous?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("honours a restricted day-of-week", () => {
    // 2026-09-17 is a Thursday; the Monday before it is 2026-09-14.
    const previous = previousOccurrence("0 0 * * 1", utc(2026, 9, 17));
    expect(previous?.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("ORs day-of-month and day-of-week when both are restricted (Vixie)", () => {
    // Thursday the 17th matches neither "the 1st" nor "a Monday", so the
    // previous hit is the Monday before it.
    const previous = previousOccurrence("0 0 1 * 1", utc(2026, 9, 17));
    expect(previous?.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("matches via day-of-month alone when only that side of the OR hits", () => {
    // 2026-09-01 is the 1st but a Tuesday: the OR must still accept it.
    const previous = previousOccurrence("0 0 1 * 1", utc(2026, 9, 2));
    expect(previous?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("requires the hour and minute together, not either", () => {
    const previous = previousOccurrence("30 9 * * *", utc(2026, 9, 17, 9, 0));
    expect(previous?.toISOString()).toBe("2026-09-16T09:30:00.000Z");
  });

  it("crosses a month boundary", () => {
    const previous = previousOccurrence("0 0 * * 1", utc(2026, 10, 1));
    expect(previous?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("crosses a year boundary", () => {
    const previous = previousOccurrence("0 0 1 1 *", utc(2026, 3, 5));
    expect(previous?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("finds a leap day when the lookback can reach it", () => {
    // Beyond the default 400-day window, so it needs an explicit lookback —
    // exactly the bound documented on MAX_LOOKBACK_DAYS.
    expect(previousOccurrence("0 0 29 2 *", utc(2026, 9, 17))).toBeNull();
    const previous = previousOccurrence("0 0 29 2 *", utc(2026, 9, 17), 1200);
    expect(previous?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
  });

  it("returns null for a schedule that can never match", () => {
    // February never has 30 days.
    expect(previousOccurrence("0 0 30 2 *", utc(2026, 9, 17), 1200)).toBeNull();
  });

  it("returns null for an unparseable expression", () => {
    expect(previousOccurrence("nonsense", utc(2026, 9, 17))).toBeNull();
  });

  it("returns null for an invalid date", () => {
    expect(previousOccurrence("0 * * * *", new Date(Number.NaN))).toBeNull();
  });

  it("looks back no further than the window it is given", () => {
    // Weekly, but asked about a window shorter than a week.
    expect(previousOccurrence("0 0 * * 1", utc(2026, 9, 16), 1)).toBeNull();
    // Same call with room to reach the Monday.
    expect(
      previousOccurrence("0 0 * * 1", utc(2026, 9, 16), 7)?.toISOString(),
    ).toBe("2026-09-14T00:00:00.000Z");
  });
});

/**
 * ADR 026 evaluates every schedule in UTC. These cases pin that down by
 * asserting exact UTC instants across both European DST transitions: if any
 * code path reasoned in local time, the offsets would shift by an hour on
 * exactly these dates (09:00 local is 07:00Z in summer and 08:00Z in winter).
 */
describe("previousOccurrence — UTC evaluation across DST boundaries", () => {
  it("fires at the same UTC instant through the spring-forward transition", () => {
    // 2026-03-29: EU clocks jump 01:00Z -> 02:00Z local, and 02:30 local does
    // not exist that day. A UTC schedule is unaffected: it is still 02:30Z.
    expect(
      previousOccurrence("30 2 * * *", utc(2026, 3, 29, 3, 0))?.toISOString(),
    ).toBe("2026-03-29T02:30:00.000Z");
    expect(
      previousOccurrence("0 9 * * *", utc(2026, 3, 29, 12, 0))?.toISOString(),
    ).toBe("2026-03-29T09:00:00.000Z");
  });

  it("fires at the same UTC instant through the fall-back transition", () => {
    // 2026-10-25: EU clocks repeat 01:00-02:00 local. UTC has no repeat, so
    // there is exactly one occurrence, one hour before the previous day's.
    const previous = previousOccurrence("0 9 * * *", utc(2026, 10, 25, 12, 0));
    expect(previous?.toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });

  it("does not skip or double-fire the hour that does not exist locally", () => {
    // The 01:00Z slot exists exactly once in UTC on both transition days —
    // the case a local-time implementation gets wrong in opposite directions.
    expect(
      previousOccurrence("0 1 * * *", utc(2026, 3, 29, 1, 30))?.toISOString(),
    ).toBe("2026-03-29T01:00:00.000Z");
    expect(
      previousOccurrence("0 1 * * *", utc(2026, 10, 25, 1, 30))?.toISOString(),
    ).toBe("2026-10-25T01:00:00.000Z");
  });

  it("keeps daily schedules 24 hours apart across a transition", () => {
    // Under local-time reasoning these two would be 23 or 25 hours apart.
    const before = previousOccurrence("0 9 * * *", utc(2026, 3, 28, 12, 0))!;
    const after = previousOccurrence("0 9 * * *", utc(2026, 3, 29, 12, 0))!;
    expect(after.getTime() - before.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("isDueForSchedule", () => {
  it("is due when a scheduled window has passed since the last run", () => {
    expect(
      isDueForSchedule({
        expression: "0 9 * * *",
        lastRunAt: utc(2026, 9, 16, 9, 0),
        createdAt: utc(2026, 9, 1),
        now: utc(2026, 9, 17, 9, 0),
      }),
    ).toBe(true);
  });

  it("is not due before the window arrives", () => {
    expect(
      isDueForSchedule({
        expression: "0 9 * * *",
        lastRunAt: utc(2026, 9, 16, 9, 0),
        createdAt: utc(2026, 9, 1),
        now: utc(2026, 9, 17, 8, 59),
      }),
    ).toBe(false);
  });

  it("is not due when the last run was the most recent occurrence (boundary)", () => {
    // The strict `>` is what stops a test firing twice for one window.
    expect(
      isDueForSchedule({
        expression: "0 * * * *",
        lastRunAt: utc(2026, 9, 17, 14, 0),
        createdAt: utc(2026, 9, 1),
        now: utc(2026, 9, 17, 14, 0),
      }),
    ).toBe(false);
  });

  it("is due once a later occurrence lands after the last run", () => {
    expect(
      isDueForSchedule({
        expression: "0 * * * *",
        lastRunAt: utc(2026, 9, 17, 14, 0),
        createdAt: utc(2026, 9, 1),
        now: utc(2026, 9, 17, 15, 0),
      }),
    ).toBe(true);
  });

  it("never fires before the test existed, however recent the window", () => {
    // Created at 09:30 with a daily-09:00 schedule: today's window elapsed
    // *before* the test existed, so it waits for tomorrow rather than firing
    // the instant it is created.
    expect(
      isDueForSchedule({
        expression: "0 9 * * *",
        lastRunAt: null,
        createdAt: utc(2026, 9, 17, 9, 30),
        now: utc(2026, 9, 17, 9, 30),
      }),
    ).toBe(false);
  });

  it("fires at the next window after creation", () => {
    expect(
      isDueForSchedule({
        expression: "0 9 * * *",
        lastRunAt: null,
        createdAt: utc(2026, 9, 17, 9, 30),
        now: utc(2026, 9, 18, 9, 0),
      }),
    ).toBe(true);
  });

  it("fires when the test was created before its first window", () => {
    expect(
      isDueForSchedule({
        expression: "0 9 * * *",
        lastRunAt: null,
        createdAt: utc(2026, 9, 17, 8, 0),
        now: utc(2026, 9, 17, 9, 0),
      }),
    ).toBe(true);
  });

  it("catches up once after a long outage, not once per missed window", () => {
    // Last ran at midnight; it is now 14:23. An hourly schedule has missed 14
    // windows, but this answers a single boolean: one dispatch, caught up.
    const input = {
      expression: "0 * * * *",
      lastRunAt: utc(2026, 9, 17, 0, 0),
      createdAt: utc(2026, 9, 1),
      now: utc(2026, 9, 17, 14, 23),
    };
    expect(isDueForSchedule(input)).toBe(true);
    // And having just run, the very next tick is not due again.
    expect(
      isDueForSchedule({ ...input, lastRunAt: input.now }),
    ).toBe(false);
  });

  it("stays correct for sub-hourly schedules the validator rejects", () => {
    // `meetsMinimumInterval` now rejects `*/15 * * * *`, so a schedule this
    // short can only exist if it was saved before that tightening. The
    // scheduler must still dispatch it at most once per window rather than
    // once per missed tick.
    const base = {
      expression: "*/15 * * * *",
      createdAt: utc(2026, 9, 1),
    };
    expect(
      isDueForSchedule({ ...base, lastRunAt: utc(2026, 9, 17, 10, 0), now: utc(2026, 9, 17, 10, 7) }),
    ).toBe(false);
    expect(
      isDueForSchedule({ ...base, lastRunAt: utc(2026, 9, 17, 10, 0), now: utc(2026, 9, 17, 10, 15) }),
    ).toBe(true);
  });

  it("is never due on an unparseable schedule", () => {
    expect(
      isDueForSchedule({
        expression: "0 0 * * MON",
        lastRunAt: null,
        createdAt: utc(2026, 1, 1),
        now: utc(2026, 9, 17),
      }),
    ).toBe(false);
  });

  it("is never due on a schedule that can never match", () => {
    expect(
      isDueForSchedule({
        expression: "0 0 30 2 *",
        lastRunAt: null,
        createdAt: utc(2026, 1, 1),
        now: utc(2026, 9, 17),
      }),
    ).toBe(false);
  });

  it("exposes a lookback window of at least a year", () => {
    expect(MAX_LOOKBACK_DAYS).toBeGreaterThanOrEqual(366);
  });
});

describe("minimumIntervalMs", () => {
  it("measures an hourly schedule as one hour", () => {
    expect(minimumIntervalMs("0 * * * *", utc(2026, 9, 17, 12))).toBe(3_600_000);
  });

  it("measures a weekly schedule as a week", () => {
    expect(minimumIntervalMs("0 9 * * 1", utc(2026, 9, 17, 12))).toBe(
      7 * 24 * 3_600_000,
    );
  });

  it("finds the short gap in a schedule whose gap is not constant", () => {
    // Daily at 00:00 and 00:30: sampled occurrences include the 30-minute
    // pair, which is the gap the minimum-interval rule is about.
    expect(minimumIntervalMs("0,30 0 * * *", utc(2026, 9, 17, 12))).toBe(
      30 * 60_000,
    );
  });

  it("reports the one gap it can see on a sparse schedule", () => {
    // A yearly schedule has at most two occurrences inside the lookback, so
    // the scan ends there and reports the one gap it saw.
    expect(minimumIntervalMs("0 0 1 1 *", utc(2026, 9, 17, 12))).toBe(
      365 * 24 * 3_600_000,
    );
  });

  it("returns null when there is nothing to measure", () => {
    expect(minimumIntervalMs("0 0 31 2 *", utc(2026, 9, 17, 12))).toBeNull();
    expect(minimumIntervalMs("not a cron", utc(2026, 9, 17, 12))).toBeNull();
  });
});

/*
 * Issue #31 part 1: evaluating a schedule in a project's own zone.
 *
 * The design decision these hold in place is *named zone, resolved per
 * occurrence* rather than a stored offset — so the assertions below are largely
 * about the same wall time producing different instants across a transition,
 * which is exactly what an offset cannot do.
 */
describe("previousOccurrenceInTimeZone", () => {
  const NY = "America/New_York";

  it("resolves a daily wall time in the project's zone", () => {
    // 09:00 New York in January is 14:00Z (EST, -5).
    expect(
      previousOccurrenceInTimeZone("0 9 * * *", utc(2026, 1, 15, 23, 0), NY)?.toISOString(),
    ).toBe("2026-01-15T14:00:00.000Z");
  });

  // The point of the whole feature: the *same* expression means the same local
  // time all year, so it is a different instant either side of the transition.
  // A fixed offset would return the same UTC instant in both months.
  it("keeps the wall time fixed across a DST transition", () => {
    expect(
      previousOccurrenceInTimeZone("0 9 * * *", utc(2026, 1, 15, 23, 0), NY)?.toISOString(),
    ).toBe("2026-01-15T14:00:00.000Z");
    expect(
      previousOccurrenceInTimeZone("0 9 * * *", utc(2026, 7, 15, 23, 0), NY)?.toISOString(),
    ).toBe("2026-07-15T13:00:00.000Z");
  });

  it("still returns the latest occurrence at or before the reference", () => {
    // 12:00Z is 08:00 in New York, so the 09:00 run has not happened yet and the
    // previous day's is the answer.
    expect(
      previousOccurrenceInTimeZone("0 9 * * *", utc(2026, 1, 15, 12, 0), NY)?.toISOString(),
    ).toBe("2026-01-14T14:00:00.000Z");
  });

  // ADR 026's spring-forward answer: the wall time does not exist, so that day
  // is skipped and the previous day is returned. The alternative — shifting to
  // 03:30 — would invent a time nobody configured.
  it("skips a wall time that does not exist on the transition day", () => {
    const occurrence = previousOccurrenceInTimeZone(
      "30 2 * * *",
      utc(2026, 3, 8, 23, 0),
      NY,
    );

    expect(occurrence?.toISOString()).toBe("2026-03-07T07:30:00.000Z");
  });

  it("runs on the transition day itself for a time that does exist", () => {
    // 02:30 is skipped; 09:00 is not, so the same day still produces a run.
    expect(
      previousOccurrenceInTimeZone("0 9 * * *", utc(2026, 3, 8, 23, 0), NY)?.toISOString(),
    ).toBe("2026-03-08T13:00:00.000Z");
  });

  // ADR 026's fall-back answer: take the earlier of the two, so the run is not an
  // hour late for no reason the user asked for.
  it("takes the earlier instant for a wall time that happens twice", () => {
    const occurrence = previousOccurrenceInTimeZone(
      "30 1 * * *",
      utc(2026, 11, 1, 23, 0),
      NY,
    );

    expect(occurrence?.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  // The local day is 23 or 25 hours across a transition, so a lookback that
  // stepped by a fixed 24 hours would drift by an hour on one side of it.
  it("walks local calendar days, not 24-hour steps", () => {
    // 01:00 local on 2026-03-09 is 05:00Z (EDT). Asking from 04:00Z on the 9th
    // — which is 23:00 on the 8th locally — must find the 8th's 01:00 EST
    // (06:00Z), not the 9th's.
    expect(
      previousOccurrenceInTimeZone("0 1 * * *", utc(2026, 3, 9, 4, 0), NY)?.toISOString(),
    ).toBe("2026-03-08T06:00:00.000Z");
  });

  it("matches the day-of-week in the project's zone", () => {
    // 2026-03-02 is a Monday. A Monday 09:00 New York schedule requested just
    // after it should find that day, not the boundary day in UTC terms.
    expect(
      previousOccurrenceInTimeZone("0 9 * * 1", utc(2026, 3, 2, 23, 0), NY)?.toISOString(),
    ).toBe("2026-03-02T14:00:00.000Z");
  });

  it("matches the day-of-month in the project's zone", () => {
    expect(
      previousOccurrenceInTimeZone("0 0 15 * *", utc(2026, 1, 15, 23, 0), NY)?.toISOString(),
    ).toBe("2026-01-15T05:00:00.000Z");
  });

  // UTC is the pre-#31 behaviour for every project that has not set a zone, so it
  // must be delegated unchanged rather than recomputed through the local walk.
  it("is identical to the UTC path for UTC and for an unusable zone", () => {
    const at = utc(2026, 1, 15, 23, 0);
    const expected = previousOccurrence("0 9 * * *", at)?.toISOString();

    expect(previousOccurrenceInTimeZone("0 9 * * *", at, "UTC")?.toISOString()).toBe(expected);
    // A bad stored value degrades one project to the old behaviour rather than
    // throwing and abandoning the whole candidate pass.
    expect(previousOccurrenceInTimeZone("0 9 * * *", at, "Not/AZone")?.toISOString()).toBe(
      expected,
    );
    expect(previousOccurrenceInTimeZone("0 9 * * *", at, "")?.toISOString()).toBe(expected);
  });

  it("returns null for an unparseable expression, as the UTC path does", () => {
    expect(previousOccurrenceInTimeZone("not a cron", utc(2026, 1, 15, 23, 0), NY)).toBeNull();
  });

  it("returns null for an invalid reference date", () => {
    expect(
      previousOccurrenceInTimeZone("0 9 * * *", new Date(Number.NaN), NY),
    ).toBeNull();
  });

  it("finds an occurrence for a sparse schedule, so the lookback is not too short", () => {
    // Yearly; would be missed entirely by a lookback of a few days.
    expect(
      previousOccurrenceInTimeZone("0 0 1 1 *", utc(2026, 6, 1, 0, 0), NY)?.toISOString(),
    ).toBe("2026-01-01T05:00:00.000Z");
  });
});

describe("isDueForSchedule with a project timezone", () => {
  const NY = "America/New_York";

  it("fires when the zone's wall time has passed", () => {
    // 09:05 in New York on a summer day is 13:05Z.
    expect(
      isDueForSchedule({
        expression: "0 9 * * *",
        lastRunAt: null,
        createdAt: utc(2026, 1, 1),
        now: utc(2026, 7, 15, 13, 5),
        timeZone: NY,
      }),
    ).toBe(true);
  });

  it("does not fire before the zone's wall time, even though UTC says otherwise", () => {
    // The boundary the zone actually moves. `lastRunAt` is the previous local
    // run — 09:00 EDT on the 14th, which is 13:00Z — so the question is whether
    // *today's* 09:00 local has passed yet.
    const previousRun = utc(2026, 7, 14, 13, 0);

    // 12:05Z is 08:05 local: today's 09:00 has not arrived, so the previous
    // occurrence is still the 14th's and nothing is due. Reading the expression
    // as UTC would have fired at 09:00Z, three hours too early.
    expect(
      isDueForSchedule({
        expression: "0 9 * * *",
        lastRunAt: previousRun,
        createdAt: utc(2026, 1, 1),
        now: utc(2026, 7, 15, 12, 5),
        timeZone: NY,
      }),
    ).toBe(false);

    // 13:05Z is 09:05 local, so it has.
    expect(
      isDueForSchedule({
        expression: "0 9 * * *",
        lastRunAt: previousRun,
        createdAt: utc(2026, 1, 1),
        now: utc(2026, 7, 15, 13, 5),
        timeZone: NY,
      }),
    ).toBe(true);
  });

  it("is unchanged from the UTC behaviour when no zone is given", () => {
    const input = {
      expression: "0 9 * * *",
      lastRunAt: null,
      createdAt: utc(2026, 1, 1),
      now: utc(2026, 7, 15, 12, 5),
    };
    expect(isDueForSchedule(input)).toBe(
      isDueForSchedule({ ...input, timeZone: "UTC" }),
    );
    expect(isDueForSchedule({ ...input, timeZone: null })).toBe(isDueForSchedule(input));
  });

  it("still catches up once per missed window in a zone", () => {
    // Same shape as the UTC catch-up test: having just run, the next tick is not
    // due again; after a long gap it fires once.
    const base = {
      expression: "0 9 * * *",
      createdAt: utc(2026, 1, 1),
      timeZone: NY,
    };
    expect(
      isDueForSchedule({ ...base, lastRunAt: utc(2026, 7, 15, 13, 0), now: utc(2026, 7, 15, 13, 5) }),
    ).toBe(false);
    expect(
      isDueForSchedule({ ...base, lastRunAt: utc(2026, 7, 1), now: utc(2026, 7, 15, 13, 5) }),
    ).toBe(true);
  });

  it("tolerates an invalid zone by treating it as UTC", () => {
    expect(
      isDueForSchedule({
        expression: "0 9 * * *",
        lastRunAt: null,
        createdAt: utc(2026, 1, 1),
        now: utc(2026, 7, 15, 12, 5),
        timeZone: "Not/AZone",
      }),
    ).toBe(true);
  });
});
