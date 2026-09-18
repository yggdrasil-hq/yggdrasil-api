import { describe, expect, it } from "vitest";
import {
  MINIMUM_SCHEDULE_INTERVAL_MS,
  TEST_SCHEDULE_PRESETS,
  isValidCronExpression,
  meetsMinimumInterval,
} from "./types.js";

/**
 * A fixed `at` so the assertions do not depend on when the suite runs — the
 * interval between a schedule's occurrences varies with the calendar (a
 * day-of-month schedule has a short gap in some months), and a rule about the
 * *minimum* interval must not look flaky because of that.
 */
const at = new Date(Date.UTC(2026, 8, 17, 12, 0, 0, 0));

describe("isValidCronExpression", () => {
  it("accepts five non-empty fields", () => {
    expect(isValidCronExpression("0 9 * * 1")).toBe(true);
  });

  it("rejects the wrong field count or empty fields", () => {
    expect(isValidCronExpression("0 9 * *")).toBe(false);
    expect(isValidCronExpression("0 9 * * 1 1")).toBe(false);
    expect(isValidCronExpression("0 9 *  *")).toBe(false);
  });

  it("does not itself validate field syntax", () => {
    // Documented: this is only the shape check. `parseCron` is the syntax gate,
    // and `meetsMinimumInterval` treats an unparseable expression as passable
    // rather than double-reporting it.
    expect(isValidCronExpression("x y z w v")).toBe(true);
  });
});

describe("meetsMinimumInterval", () => {
  it("accepts every preset the product ships", () => {
    for (const preset of Object.values(TEST_SCHEDULE_PRESETS)) {
      expect(meetsMinimumInterval(preset, at), preset).toBe(true);
    }
  });

  it("rejects the schedules the old pattern check let through (#21)", () => {
    // Each of these fires every minute for a window, so each `test_run` would
    // be a real cluster job. The previous implementation pattern-matched the
    // string and accepted all three.
    expect(meetsMinimumInterval("* 10 * * *", at)).toBe(false);
    expect(meetsMinimumInterval("0-59 10 * * *", at)).toBe(false);
    expect(meetsMinimumInterval("* * * * 1", at)).toBe(false);
  });

  it("rejects the sub-hour patterns the old check already caught", () => {
    expect(meetsMinimumInterval("* * * * *", at)).toBe(false);
    expect(meetsMinimumInterval("*/15 * * * *", at)).toBe(false);
    expect(meetsMinimumInterval("*/1 * * * *", at)).toBe(false);
    expect(meetsMinimumInterval("0,30 * * * *", at)).toBe(false);
  });

  it("accepts exactly-hourly and longer schedules", () => {
    expect(meetsMinimumInterval("0 * * * *", at)).toBe(true);
    expect(meetsMinimumInterval("30 * * * *", at)).toBe(true);
    expect(meetsMinimumInterval("0 */2 * * *", at)).toBe(true);
    expect(meetsMinimumInterval("0 9-17 * * *", at)).toBe(true);
    expect(meetsMinimumInterval("0 9 * * 1-5", at)).toBe(true);
    expect(meetsMinimumInterval("0 0 1 * *", at)).toBe(true);
    expect(meetsMinimumInterval("0 0 1 1 *", at)).toBe(true);
  });

  it("rejects an hourly-looking schedule whose minutes are closer than an hour", () => {
    // Every 3 hours, at :15 and :45 — the field reads as a long interval, the
    // real gap inside the hour is 30 minutes.
    expect(meetsMinimumInterval("15,45 */3 * * *", at)).toBe(false);
  });

  it("enforces the boundary at exactly one hour, not one minute either side", () => {
    expect(meetsMinimumInterval("0 * * * *", at)).toBe(true);
    expect(meetsMinimumInterval("0,59 * * * *", at)).toBe(false);
  });

  it("takes the minimum when a schedule's gap is not constant", () => {
    // Monthly on the 1st and 15th: the short gap is ~14 days, well over an
    // hour. What matters is that the *smallest* sampled gap decides.
    expect(meetsMinimumInterval("0 0 1,15 * *", at)).toBe(true);
    // Daily at midnight and at 00:30: the 30-minute gap decides, even though
    // the other gap in the pair is 23.5 hours.
    expect(meetsMinimumInterval("0,30 0 * * *", at)).toBe(false);
  });

  it("passes an expression with nothing measurable rather than inventing a rule", () => {
    // Malformed (no syntax the parser accepts) and effectively unfireable
    // (Feb 29 that is also a Monday) both match fewer than two occurrences in
    // the lookback window. Neither can fire too often.
    expect(meetsMinimumInterval("0 0 31 2 *", at)).toBe(true);
    expect(meetsMinimumInterval("not a cron", at)).toBe(true);
  });

  it("treats the threshold as the documented constant", () => {
    expect(MINIMUM_SCHEDULE_INTERVAL_MS).toBe(60 * 60 * 1000);
  });
});
