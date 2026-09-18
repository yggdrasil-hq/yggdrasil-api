import { describe, expect, it } from "vitest";
import {
  addWallClockDays,
  calendarWeekday,
  isFallingBackToUtc,
  isValidTimeZone,
  resolveWallTime,
  timeZoneOrUtc,
  wallClock,
  zoneOffsetMs,
} from "./timezone.js";

/**
 * Issue #31 part 1: the zone arithmetic behind a per-project timezone.
 *
 * The whole reason this is not a stored offset is the pair of cases below. An
 * offset applied year-round reproduces the exact bug the issue complains about —
 * a schedule set up in winter drifts by an hour in summer — so these tests are
 * what hold the chosen design in place rather than the code merely being
 * *capable* of it.
 *
 * `America/New_York` throughout because its transitions are the well-known ones:
 * DST begins the second Sunday in March (2026-03-08, 02:00 EST → 03:00 EDT) and
 * ends the first Sunday in November (2026-11-01, 02:00 EDT → 01:00 EST).
 */

const NY = "America/New_York";

describe("isValidTimeZone", () => {
  it("accepts a real IANA name", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
  });

  it("rejects a typo and nothing at all", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
    // `GMT+5` is not an IANA identifier — and its sign convention is inverted
    // from what most people assume, so accepting it would be a trap rather than
    // a convenience.
    expect(isValidTimeZone("GMT+5")).toBe(false);
  });

  /*
   * A fixed **offset** is accepted, and that is deliberate rather than an
   * oversight.
   *
   * ADR 026's warning is about the *implementation* storing an offset per project
   * and applying it year-round, which reproduces the drift the issue complains
   * about. It is not a claim that an offset is an invalid thing for a user to ask
   * for — and modern ICU resolves `+05:30` as a real zone identifier, so the
   * arithmetic is correct and the result is exactly the fixed offset that was
   * asked for. Refusing it would be this module second-guessing the platform on a
   * value the platform handles properly.
   *
   * `Etc/GMT+5` is the same case wearing a tz-database name, and is accepted for
   * the same reason.
   */
  it("accepts an explicit offset identifier, which ICU resolves as a zone", () => {
    expect(isValidTimeZone("+05:30")).toBe(true);
    expect(isValidTimeZone("Etc/GMT+5")).toBe(true);
  });

  it("applies an explicit offset correctly, since it is a zone like any other", () => {
    expect(zoneOffsetMs(new Date("2026-01-15T12:00:00Z"), "+05:30")).toBe(
      5.5 * 3_600_000,
    );
    const resolved = resolveWallTime(
      { year: 2026, month: 1, day: 15, hour: 9, minute: 0 },
      "+05:30",
    );
    expect(resolved.kind).toBe("exact");
    if (resolved.kind === "nonexistent") return;
    expect(resolved.instant.toISOString()).toBe("2026-01-15T03:30:00.000Z");
    expect(wallClock(resolved.instant, "+05:30")).toMatchObject({ hour: 9, minute: 0 });
  });
});

describe("timeZoneOrUtc", () => {
  it("passes a valid zone through", () => {
    expect(timeZoneOrUtc(NY)).toBe(NY);
  });

  // A bad stored value must not wedge the scheduler: it would throw inside the
  // tick and abandon the whole candidate pass, stopping every project's tests
  // because one project's setting is wrong.
  it("falls back to UTC for an unusable value", () => {
    expect(timeZoneOrUtc("Not/AZone")).toBe("UTC");
    expect(timeZoneOrUtc(null)).toBe("UTC");
    expect(timeZoneOrUtc(undefined)).toBe("UTC");
    expect(timeZoneOrUtc("")).toBe("UTC");
  });

  it("reports a fallback only when there was something to reject", () => {
    expect(isFallingBackToUtc("Not/AZone")).toBe(true);
    // Unset is not a fallback — it is the default, and logging it every tick
    // would be noise for every project that never sets a zone.
    expect(isFallingBackToUtc(null)).toBe(false);
    expect(isFallingBackToUtc("")).toBe(false);
    expect(isFallingBackToUtc(NY)).toBe(false);
  });
});

describe("zoneOffsetMs", () => {
  it("reads the zone's offset on both sides of a transition", () => {
    expect(zoneOffsetMs(new Date("2026-01-15T12:00:00Z"), NY)).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs(new Date("2026-07-15T12:00:00Z"), NY)).toBe(-4 * 3_600_000);
  });

  it("is zero for UTC", () => {
    expect(zoneOffsetMs(new Date("2026-03-08T07:30:00Z"), "UTC")).toBe(0);
  });

  it("ignores the instant's own sub-minute remainder", () => {
    // `formatToParts` resolves to seconds, so leaving the remainder in would
    // fold it into the offset and return a value that is not a whole minute.
    const whole = zoneOffsetMs(new Date("2026-01-15T12:00:00Z"), NY);
    const withSeconds = zoneOffsetMs(new Date("2026-01-15T12:00:37.482Z"), NY);
    expect(withSeconds).toBe(whole);
  });

  it("handles a half-hour zone", () => {
    expect(zoneOffsetMs(new Date("2026-01-15T12:00:00Z"), "Asia/Kolkata")).toBe(
      5.5 * 3_600_000,
    );
  });
});

describe("wallClock", () => {
  it("reads the parts as seen in the zone", () => {
    expect(wallClock(new Date("2026-01-15T12:34:00Z"), NY)).toEqual({
      year: 2026,
      month: 1,
      day: 15,
      hour: 7,
      minute: 34,
    });
  });

  // `hourCycle: "h23"` explicitly, because with `hour12: false` some ICU versions
  // render midnight as hour 24 — which would put every midnight schedule on the
  // previous day and shift it by an hour.
  it("renders midnight as hour 0, not 24", () => {
    expect(wallClock(new Date("2026-01-15T05:00:00Z"), NY).hour).toBe(0);
  });

  it("crosses the date boundary with the zone's own date", () => {
    // 02:00Z on the 16th is still the evening of the 15th in New York.
    expect(wallClock(new Date("2026-01-16T02:00:00Z"), NY)).toMatchObject({
      day: 15,
      hour: 21,
    });
  });
});

describe("resolveWallTime — the ordinary case", () => {
  it("resolves a time that exists once", () => {
    const resolved = resolveWallTime({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, NY);

    expect(resolved.kind).toBe("exact");
    if (resolved.kind === "nonexistent") return;
    expect(resolved.instant.toISOString()).toBe("2026-01-15T14:00:00.000Z");
  });

  // The property the whole design exists for: the same wall time is a different
  // instant in winter and summer, which is what keeps "2am" meaning 2am.
  it("gives the same wall time different instants either side of a transition", () => {
    const winter = resolveWallTime({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, NY);
    const summer = resolveWallTime({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, NY);

    expect(winter.kind).not.toBe("nonexistent");
    expect(summer.kind).not.toBe("nonexistent");
    if (winter.kind === "nonexistent" || summer.kind === "nonexistent") return;
    expect(winter.instant.toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(summer.instant.toISOString()).toBe("2026-07-15T13:00:00.000Z");
  });
});

describe("resolveWallTime — spring forward (a wall time that never happens)", () => {
  // ADR 026: **skip** it. The run happens on the other 364 days and the strict-`>`
  // catch-up self-heals at the next occurrence, whereas shifting to 03:30 invents
  // a time the user did not ask for.
  it("reports 02:30 on the transition day as nonexistent", () => {
    expect(resolveWallTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY).kind).toBe(
      "nonexistent",
    );
  });

  it("reports the whole skipped hour as nonexistent", () => {
    for (const minute of [0, 1, 30, 59]) {
      expect(
        resolveWallTime({ year: 2026, month: 3, day: 8, hour: 2, minute }, NY).kind,
        `02:${minute}`,
      ).toBe("nonexistent");
    }
  });

  it("does not over-reach past the skipped hour", () => {
    // 01:59 and 03:00 both exist on that day, so a resolution that reported
    // them nonexistent would drop a legitimate run rather than one that cannot
    // happen.
    expect(resolveWallTime({ year: 2026, month: 3, day: 8, hour: 1, minute: 59 }, NY).kind).toBe(
      "exact",
    );
    expect(resolveWallTime({ year: 2026, month: 3, day: 8, hour: 3, minute: 0 }, NY).kind).toBe(
      "exact",
    );
  });
});

describe("resolveWallTime — fall back (a wall time that happens twice)", () => {
  it("reports 01:30 on the transition day as ambiguous", () => {
    expect(resolveWallTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY).kind).toBe(
      "ambiguous",
    );
  });

  // ADR 026: take the **earlier**, so the run happens at the first occurrence
  // rather than an hour late for a reason the user did not ask for.
  it("resolves an ambiguous time to the earlier of the two instants", () => {
    const resolved = resolveWallTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY);

    expect(resolved.kind).toBe("ambiguous");
    if (resolved.kind === "nonexistent") return;
    // 05:30Z is 01:30 EDT (the first one); 06:30Z would be 01:30 EST (the second).
    expect(resolved.instant.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(wallClock(resolved.instant, NY)).toMatchObject({ hour: 1, minute: 30 });
  });

  it("does not report the hours around it as ambiguous", () => {
    expect(resolveWallTime({ year: 2026, month: 11, day: 1, hour: 0, minute: 30 }, NY).kind).toBe(
      "exact",
    );
    expect(resolveWallTime({ year: 2026, month: 11, day: 1, hour: 2, minute: 30 }, NY).kind).toBe(
      "exact",
    );
  });
});

describe("addWallClockDays", () => {
  // A local day is 23 or 25 hours across a transition, so a lookback must walk
  // calendar days rather than step by a fixed 24 hours. This function is why the
  // arithmetic never sees a day length at all.
  it("steps whole calendar days", () => {
    expect(addWallClockDays({ year: 2026, month: 3, day: 9, hour: 9, minute: 0 }, -1)).toMatchObject(
      { year: 2026, month: 3, day: 8 },
    );
  });

  it("crosses a month and a year boundary", () => {
    expect(addWallClockDays({ year: 2026, month: 3, day: 1, hour: 0, minute: 0 }, -1)).toMatchObject(
      { month: 2, day: 28 },
    );
    expect(addWallClockDays({ year: 2026, month: 1, day: 1, hour: 0, minute: 0 }, -1)).toMatchObject(
      { year: 2025, month: 12, day: 31 },
    );
  });

  it("handles a leap day", () => {
    expect(addWallClockDays({ year: 2028, month: 3, day: 1, hour: 0, minute: 0 }, -1)).toMatchObject(
      { month: 2, day: 29 },
    );
  });

  it("preserves the time of day", () => {
    expect(addWallClockDays({ year: 2026, month: 6, day: 10, hour: 17, minute: 45 }, -3)).toMatchObject(
      { hour: 17, minute: 45 },
    );
  });
});

describe("calendarWeekday", () => {
  // The weekday of a *calendar date*, which is what a zoned day-of-week match
  // needs — reading it off an instant would give a different answer either side
  // of midnight.
  it("reports the weekday of the date, independent of any zone", () => {
    expect(calendarWeekday({ year: 2026, month: 3, day: 8 })).toBe(0); // Sunday
    expect(calendarWeekday({ year: 2026, month: 3, day: 9 })).toBe(1); // Monday
    expect(calendarWeekday({ year: 2026, month: 11, day: 1 })).toBe(0); // Sunday
  });
});
