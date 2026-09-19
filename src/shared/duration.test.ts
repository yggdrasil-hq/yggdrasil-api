import { describe, expect, it } from "vitest";
import { parseGoDurationMs } from "./duration.js";

/**
 * Issue #92. The parser exists so a value written for the Orchestrator can be
 * pasted into the API's `.env` unchanged, so these cases are the *Go* grammar
 * rather than a convenient subset of it — a string this accepts and Go rejects
 * (or the reverse) would make the copy this enables into a trap.
 */

describe("parseGoDurationMs", () => {
  it("parses the single-unit values an operator actually writes", () => {
    expect(parseGoDurationMs("24h")).toBe(24 * 60 * 60 * 1000);
    expect(parseGoDurationMs("48h")).toBe(48 * 60 * 60 * 1000);
    expect(parseGoDurationMs("90m")).toBe(90 * 60 * 1000);
    expect(parseGoDurationMs("45s")).toBe(45 * 1000);
    expect(parseGoDurationMs("500ms")).toBe(500);
    expect(parseGoDurationMs("2h")).toBe(2 * 60 * 60 * 1000);
  });

  it("parses Go's compound form, which is what makes it Go's grammar", () => {
    // `1h30m` is 5400000 ms in Go, and this must agree or the two env files
    // cannot hold the same string.
    expect(parseGoDurationMs("1h30m")).toBe(5_400_000);
    expect(parseGoDurationMs("1h30m15s")).toBe(5_415_000);
    expect(parseGoDurationMs("1m30s")).toBe(90_000);
  });

  it("reads `ms` as milliseconds rather than minutes-then-seconds", () => {
    // The alternation order in the segment regex is the only thing deciding
    // this, so it is asserted rather than assumed: `1ms` is 1, not 60000.
    expect(parseGoDurationMs("1ms")).toBe(1);
    expect(parseGoDurationMs("1s")).toBe(1_000);
  });

  it("accepts sub-millisecond units and rounds to whole milliseconds", () => {
    // The wire carries integers, so something has to give; sub-millisecond
    // precision is meaningless for a human-gated wait.
    expect(parseGoDurationMs("1500us")).toBe(2); // 1.5ms rounds to 2
    expect(parseGoDurationMs("1000000ns")).toBe(1);
    expect(parseGoDurationMs("µs")).toBeNull(); // no number
  });

  it("handles fractions and both signs", () => {
    expect(parseGoDurationMs("1.5h")).toBe(5_400_000);
    expect(parseGoDurationMs("+30m")).toBe(1_800_000);
    expect(parseGoDurationMs("-30m")).toBe(-1_800_000);
  });

  it("rejects a bare number, which Go also rejects", () => {
    // An operator reaching for `3600` almost certainly means seconds, but Go
    // will not take it and guessing here would make the two sides disagree about
    // the same string — the one thing this parser must not do.
    expect(parseGoDurationMs("3600")).toBeNull();
    expect(parseGoDurationMs("0")).toBeNull();
  });

  it("rejects `d`, which Go has no unit for", () => {
    // `1d` is the most natural wrong answer, and silently reading it as 1 second
    // (or 24h) would be worse than the caller falling back to its default.
    expect(parseGoDurationMs("1d")).toBeNull();
    expect(parseGoDurationMs("7d")).toBeNull();
  });

  it("rejects a trailing segment with no unit rather than ignoring it", () => {
    // Without the gap check `1h30` would parse as one hour and drop the `30`,
    // turning a typo into a smaller bound than intended.
    expect(parseGoDurationMs("1h30")).toBeNull();
    expect(parseGoDurationMs("1h 30m")).toBeNull(); // Go rejects the space too
  });

  it("rejects empty and whitespace-only input", () => {
    expect(parseGoDurationMs("")).toBeNull();
    expect(parseGoDurationMs("   ")).toBeNull();
    expect(parseGoDurationMs("+")).toBeNull();
    expect(parseGoDurationMs("-")).toBeNull();
  });

  it("tolerates surrounding whitespace, which the env file may carry", () => {
    // `GRILL_REPLY_TIMEOUT=24h ` in a hand-edited file is a real case, and Go's
    // `time.ParseDuration` rejects it — but the difference is invisible to an
    // operator either way, so trimming is the kinder reading of the same intent.
    expect(parseGoDurationMs("  24h  ")).toBe(86_400_000);
  });
});
