import { describe, expect, it } from "vitest";
import { decideTestingOutcome, testGroupLabel } from "./testing-gate.js";
import type { TestRunExecution } from "../tests/report-types.js";

/**
 * Issue #40: the Testing stage's decision. Both of the failure modes below were
 * observed on a real feature before this existed, which is why they are named in
 * the tests rather than only implied.
 */

function run(overrides: Partial<TestRunExecution> = {}): TestRunExecution {
  return {
    jobId: "job_1",
    testId: null,
    testGroup: "unit",
    status: "completed",
    report: null,
    steps: [],
    lastError: null,
    completedAt: new Date("2026-09-18T10:00:00.000Z"),
    ...overrides,
  };
}

function report(failed: number, overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job_1",
    testId: null,
    passed: 10 - failed,
    failed,
    skipped: 0,
    total: 10,
    coveragePercent: null,
    failingTests: failed > 0 ? ["renders the hero"] : [],
    summary: failed > 0 ? "1 of 10 assertions did not hold" : "",
    recordingPath: null,
    createdAt: new Date("2026-09-18T10:00:00.000Z"),
    steps: [],
    ...overrides,
  };
}

describe("decideTestingOutcome", () => {
  it("decides nothing when there are no runs", () => {
    expect(decideTestingOutcome([])).toEqual({ state: "not_run" });
  });

  it("waits while any run is still going", () => {
    expect(
      decideTestingOutcome([
        run({ report: report(0), status: "completed" }),
        run({ status: "running" }),
      ]).state,
    ).toBe("in_progress");
    expect(
      decideTestingOutcome([run({ report: report(0), status: "pending" })]).state,
    ).toBe("in_progress");
  });

  it("advances when every run reported and none reported a failure", () => {
    expect(
      decideTestingOutcome([
        run({ report: report(0), testGroup: "unit" }),
        run({ report: report(0), testGroup: "integration" }),
      ]),
    ).toEqual({ state: "advance" });
  });

  it("returns the feature when a report recorded failures", () => {
    const decision = decideTestingOutcome([
      run({ report: report(0), testGroup: "unit" }),
      run({ report: report(3), testGroup: "integration" }),
    ]);

    expect(decision.state).toBe("returned");
    // The comment is carried onto the returned feature and read by both a human
    // and the next build's agent, so it has to name the group and the tests.
    expect(decision.reason).toContain("Integration tests");
    expect(decision.reason).toContain("1 of 10 assertions did not hold");
    expect(decision.reason).toContain("renders the hero");
  });

  it("names the earliest failure, not the last", () => {
    const decision = decideTestingOutcome([
      run({ report: report(1, { summary: "unit broke first" }), testGroup: "unit" }),
      run({ report: report(1, { summary: "integration broke later" }), testGroup: "integration" }),
    ]);

    expect(decision.reason).toContain("unit broke first");
  });

  // The bug that started this: a failed run with no report contributed nothing
  // to a tally built from reports, so a page of failures read "0 failed".
  it("does not mistake a run that failed without reporting for a pass", () => {
    const decision = decideTestingOutcome([
      run({
        status: "failed",
        lastError: "no image configured for script_test_run",
      }),
    ]);

    expect(decision.state).toBe("errored");
    expect(decision.reason).toContain("no image configured for script_test_run");
    expect(decision.reason).toContain("Unit tests");
  });

  // The other half of the same bug: the old gate waited for a report that was
  // never coming, so this feature sat in `testing` indefinitely.
  it("decides even when no run ever reported", () => {
    expect(
      decideTestingOutcome([
        run({ status: "failed", testGroup: "unit" }),
        run({ status: "failed", testGroup: "integration" }),
      ]).state,
    ).toBe("errored");
  });

  it("treats a run that succeeded without submitting a report as an error, not a pass", () => {
    // The job exited 0 and wrote nothing. "The tests passed" is the one wrong
    // answer that costs the most, so it must not be inferred from an exit code.
    const decision = decideTestingOutcome([run({ status: "completed" })]);

    expect(decision.state).toBe("errored");
    expect(decision.reason).toContain("without submitting a report");
  });

  it("treats a cancelled run as an error rather than as evidence about the code", () => {
    expect(decideTestingOutcome([run({ status: "cancelled" })]).state).toBe("errored");
  });

  // Precedence: real evidence about the code outranks an inconclusive run, so a
  // feature with a genuine reported failure is returned to implementation rather
  // than parked as an environment error.
  it("prefers a reported failure over an unreported one", () => {
    const decision = decideTestingOutcome([
      run({ status: "failed", testGroup: "unit" }),
      run({ report: report(2), testGroup: "integration" }),
    ]);

    expect(decision.state).toBe("returned");
    expect(decision.reason).toContain("Integration tests");
  });

  it("falls back to a count when a report names no failing test and has no summary", () => {
    const decision = decideTestingOutcome([
      run({ report: report(2, { failingTests: [], summary: "" }) }),
    ]);

    expect(decision.reason).toContain("2 failed");
  });

  it("truncates a long failing-test list rather than sending it whole", () => {
    const decision = decideTestingOutcome([
      run({
        report: report(8, {
          failingTests: ["a", "b", "c", "d", "e", "f", "g", "h"],
          summary: "",
        }),
      }),
    ]);

    expect(decision.reason).toContain("a, b, c, d, e, +3 more");
  });
});

describe("testGroupLabel", () => {
  it("names each group and falls back to Agentic", () => {
    expect(testGroupLabel("unit")).toBe("Unit tests");
    expect(testGroupLabel("integration")).toBe("Integration tests");
    expect(testGroupLabel(null)).toBe("Agentic tests");
  });
});
