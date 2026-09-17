import { describe, expect, it } from "vitest";
import {
  capExceededMessage,
  evaluateTokenCap,
  mayStartTokenConsumingJob,
  monthPeriod,
  resolveQuotaOverride,
} from "./evaluate.js";
import { consumesTokens, DEFAULT_RESOURCE_QUOTA, TOKEN_CONSUMING_KINDS } from "./types.js";
import type { JobKind } from "../jobs/types.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";

function evaluate(cap: number | null, usedTokens: number, now = new Date("2026-09-17T12:00:00Z")) {
  return evaluateTokenCap({ projectId: PROJECT, cap, usedTokens, now });
}

describe("monthPeriod (ADR 030 §3)", () => {
  it("starts at the first instant of the UTC month and excludes the next one", () => {
    const { start, end } = monthPeriod(new Date("2026-09-17T23:59:59.999Z"));
    expect(start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rolls over into January of the next year", () => {
    const { start, end } = monthPeriod(new Date("2026-12-31T23:59:59Z"));
    expect(start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("handles February in a leap year without a month-length table", () => {
    const { start, end } = monthPeriod(new Date("2028-02-29T08:00:00Z"));
    expect(start.toISOString()).toBe("2028-02-01T00:00:00.000Z");
    expect(end.toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });

  it("handles February in a non-leap year", () => {
    const { end } = monthPeriod(new Date("2027-02-28T23:00:00Z"));
    expect(end.toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });

  it("uses UTC, not the host's local time (a month boundary is not a local event)", () => {
    // 2026-10-01T00:30Z is still 2026-09-30 in every negative-offset zone; the
    // period must follow UTC regardless of where the API happens to run.
    const { start } = monthPeriod(new Date("2026-10-01T00:30:00Z"));
    expect(start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("evaluateTokenCap: the at-cap boundary (ADR 030 §4)", () => {
  it("is not exceeded one token under the cap", () => {
    const state = evaluate(1000, 999);
    expect(state.exceeded).toBe(false);
    expect(state.remainingTokens).toBe(1);
    expect(mayStartTokenConsumingJob(state)).toBe(true);
  });

  it("IS exceeded exactly at the cap — the boundary that defines the feature", () => {
    // `used > cap` would let a project spend its whole budget and then start
    // one more job on top, which is the failure mode this test exists to
    // prevent.
    const state = evaluate(1000, 1000);
    expect(state.exceeded).toBe(true);
    expect(state.remainingTokens).toBe(0);
    expect(mayStartTokenConsumingJob(state)).toBe(false);
  });

  it("is exceeded one token over the cap", () => {
    const state = evaluate(1000, 1001);
    expect(state.exceeded).toBe(true);
    // Floors at zero: "how much is left" is never a negative number a UI could
    // render as budget coming back.
    expect(state.remainingTokens).toBe(0);
  });

  it("is not exceeded when the cap is null, however much was used", () => {
    const state = evaluate(null, 999_999_999);
    expect(state.cap).toBeNull();
    expect(state.remainingTokens).toBeNull();
    expect(state.exceeded).toBe(false);
    expect(mayStartTokenConsumingJob(state)).toBe(true);
  });

  it("treats a cap of 0 as permitting nothing further, not as one more job", () => {
    // The deliberate consequence of `used >= cap`: a zero cap blocks
    // immediately, so "spend nothing this period" means what it says.
    const state = evaluate(0, 0);
    expect(state.exceeded).toBe(true);
    expect(state.remainingTokens).toBe(0);
  });

  it("distinguishes 'uncapped' from 'zero cap' — the reason absence is a row, not a value", () => {
    expect(evaluate(null, 500).exceeded).toBe(false);
    expect(evaluate(0, 500).exceeded).toBe(true);
  });

  it("never reports negative usage", () => {
    const state = evaluate(100, -5);
    expect(state.usedTokens).toBe(0);
    expect(state.exceeded).toBe(false);
  });

  it("reports the period it evaluated against", () => {
    const state = evaluate(100, 0, new Date("2026-09-17T12:00:00Z"));
    expect(state.periodStart).toBe("2026-09-01T00:00:00.000Z");
    expect(state.periodEnd).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("evaluateTokenCap: cap changes and rollover", () => {
  it("clears a block when the cap is raised above current usage mid-period", () => {
    const overCap = evaluate(1000, 1500);
    expect(overCap.exceeded).toBe(true);

    const raised = evaluate(5000, 1500);
    expect(raised.exceeded).toBe(false);
    expect(raised.remainingTokens).toBe(3500);
  });

  it("re-blocks when a cap is lowered below current usage", () => {
    const state = evaluate(100, 1500);
    expect(state.exceeded).toBe(true);
  });

  it("starts a fresh period at the month boundary, so last month's spend stops counting", () => {
    const september = evaluate(1000, 1000, new Date("2026-09-30T23:59:59Z"));
    expect(september.exceeded).toBe(true);

    // Same cap, same usage rows: only the period moved. The usage figure itself
    // is recomputed by the caller for the new window, which is exactly why the
    // counter is an aggregation rather than a stored running total.
    const october = evaluate(1000, 0, new Date("2026-10-01T00:00:00Z"));
    expect(october.exceeded).toBe(false);
    expect(october.periodStart).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("capExceededMessage", () => {
  it("names the project, the spend, the cap and the remedy", () => {
    const message = capExceededMessage(evaluate(1000, 1200));
    expect(message).toContain(PROJECT);
    expect(message).toContain("1200 of 1000 tokens");
    expect(message).toContain("raise or clear the cap");
  });
});

describe("consumesTokens (ADR 030 §2)", () => {
  it("covers exactly the five agent kinds that resolve a model config", () => {
    for (const kind of TOKEN_CONSUMING_KINDS) {
      expect(consumesTokens(kind)).toBe(true);
    }
  });

  it("excludes every deterministic kind, so a cap cannot block deploys or tests", () => {
    // A project over its model budget must still be able to deploy, roll back,
    // and run its script tests — gating those would take shipping hostage to
    // spend.
    const deterministic: JobKind[] = ["deploy", "script_test_run", "rollback"];
    for (const kind of deterministic) {
      expect(consumesTokens(kind)).toBe(false);
    }
  });
});

describe("resolveQuotaOverride", () => {
  it("returns the stored override when there is one", () => {
    expect(
      resolveQuotaOverride({ cpuMillicores: 2000, memoryMib: 4096, pods: 4 }),
    ).toEqual({ cpuMillicores: 2000, memoryMib: 4096, pods: 4 });
  });

  it("falls back to the platform defaults when there is none", () => {
    expect(resolveQuotaOverride(null)).toEqual({ ...DEFAULT_RESOURCE_QUOTA });
  });
});
