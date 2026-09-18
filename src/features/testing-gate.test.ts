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
    skipReason: null,
    createdAt: new Date("2026-09-18T10:00:00.000Z"),
    steps: [],
    ...overrides,
  };
}

/**
 * The report the Orchestrator synthesizes for a group this installation cannot
 * run (issue #44), and the one the entrypoint writes for a group the project has
 * no script for. They differ only in `skipReason` — which is exactly the point of
 * issue #53: the counts are identical, so the enum is what carries the meaning.
 */
function skippedGroup(skipReason: "no_script" | "runner_unavailable" | null) {
  return {
    passed: 0,
    failed: 0,
    skipped: 1,
    total: 1,
    failingTests: [],
    summary:
      skipReason === "runner_unavailable"
        ? "Skipped (unit): this installation has no script_test_run image configured (set SCRIPT_TEST_RUN_IMAGE on the Orchestrator). No verification was performed for this group."
        : "No test-unit.sh found; test group disabled.",
    skipReason,
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

/*
 * Issue #53. Before this, a group skipped because the *installation* could not
 * run it counted as verified — so a feature whose only runs were skipped probes
 * advanced to Agentic Review having checked nothing. The two causes of a skip
 * produce byte-identical counts, which is why every test below pairs the two
 * against each other: a change that made one behave like the other would still
 * pass a test that only asserted one of them.
 */
describe("decideTestingOutcome — a skipped group (issue #53)", () => {
  it("advances when the project has no script for the group", () => {
    // ADR 015 item 10: script presence *is* the toggle, so there was nothing to
    // verify and nothing to worry about.
    expect(
      decideTestingOutcome([
        run({ report: report(0, skippedGroup("no_script")) }),
      ]),
    ).toEqual({ state: "advance" });
  });

  it("errors when the installation could not run the group", () => {
    const decision = decideTestingOutcome([
      run({ report: report(0, skippedGroup("runner_unavailable")) }),
    ]);

    expect(decision.state).toBe("errored");
  });

  // The regression this issue is about: the identical counts must not decide it.
  it("distinguishes the two causes from identical counts", () => {
    const noScript = decideTestingOutcome([
      run({ report: report(0, skippedGroup("no_script")) }),
    ]);
    const noRunner = decideTestingOutcome([
      run({ report: report(0, skippedGroup("runner_unavailable")) }),
    ]);

    expect(noScript.state).toBe("advance");
    expect(noRunner.state).toBe("errored");
  });

  it("names the group and carries the reason an operator can act on", () => {
    const decision = decideTestingOutcome([
      run({ report: report(0, skippedGroup("runner_unavailable")) }),
    ]);

    // The reason is the report's own summary, written by the side that saw the
    // cause — so it names the setting rather than restating "skipped".
    expect(decision.reason).toContain("script_test_run image");
    expect(decision.reason).toContain("SCRIPT_TEST_RUN_IMAGE");
  });

  it("falls back to naming the group when the report gave no summary", () => {
    const decision = decideTestingOutcome([
      run({
        testGroup: "integration",
        report: report(0, {
          passed: 0,
          skipped: 1,
          total: 1,
          summary: "",
          skipReason: "runner_unavailable",
        }),
      }),
    ]);

    expect(decision.reason).toBe("Integration tests could not run");
  });

  // Absence is the pre-#53 shape and must keep behaving as it did, or the API
  // change would silently change the outcome of every report already stored.
  it("treats an unstated reason as it treated every skip before the field existed", () => {
    expect(
      decideTestingOutcome([run({ report: report(0, skippedGroup(null)) })]),
    ).toEqual({ state: "advance" });
  });

  it("does not let an install-caused skip mask a real test failure", () => {
    // The agentic group ran and a test failed. That is evidence about the code
    // and is the one outcome worth acting on, so it wins over "we could not run
    // the unit group" — including when the skip is the earlier run of the two.
    const decision = decideTestingOutcome([
      run({ testGroup: "unit", report: report(0, skippedGroup("runner_unavailable")) }),
      run({ testGroup: "integration", report: report(3) }),
    ]);

    expect(decision.state).toBe("returned");
    expect(decision.reason).toContain("Integration tests");
  });

  it("does not advance when every group was skipped because of the install", () => {
    // The exact shape the bug produced: two probes, both skipped, nothing else.
    expect(
      decideTestingOutcome([
        run({ testGroup: "unit", report: report(0, skippedGroup("runner_unavailable")) }),
        run({
          testGroup: "integration",
          report: report(0, skippedGroup("runner_unavailable")),
        }),
      ]).state,
    ).toBe("errored");
  });

  // A crashed run and an unrunnable group are both "testing could not be
  // completed"; the install cause is reported because it names a setting.
  it("prefers the install cause over a run that ended without reporting", () => {
    const decision = decideTestingOutcome([
      run({ status: "failed", testGroup: "integration", lastError: "pod crashed" }),
      run({ testGroup: "unit", report: report(0, skippedGroup("runner_unavailable")) }),
    ]);

    expect(decision.state).toBe("errored");
    expect(decision.reason).toContain("script_test_run image");
  });
});
