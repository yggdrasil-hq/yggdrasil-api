import { describe, expect, it, vi } from "vitest";
import {
  MAX_TESTING_GATE_CANDIDATES,
  runTestingGateTick,
  type TestingGateSchedulerDeps,
} from "./testing-gate-reconcile.js";
import type { TestRunExecution } from "../tests/report-types.js";

/**
 * Issue #40's second trigger. The tick's whole reason to exist is the case the
 * event path cannot see: a run that finished without ever reporting, which
 * leaves a feature in `testing` with nothing to wake the gate up.
 */

function run(overrides: Partial<TestRunExecution> = {}): TestRunExecution {
  return {
    jobId: "job_1",
    testId: null,
    testGroup: "unit",
    status: "failed",
    report: null,
    steps: [],
    lastError: "no image configured for script_test_run",
    completedAt: new Date(),
    ...overrides,
  };
}

function build(candidates: Array<{ id: string; projectId: string }>, options: {
  runsByFeature?: Record<string, unknown[]>;
  featureStatus?: () => string;
} = {}) {
  const setReturned = vi.fn(async () => null);
  const updateStatus = vi.fn(async () => null);
  const setInReview = vi.fn(async () => null);
  const setAgenticReview = vi.fn(async () => ({ id: "feature" }));

  const listTestingWithTerminalRuns = vi.fn(async () => candidates);
  const listByFeature = vi.fn(
    async (featureId: string) => options.runsByFeature?.[featureId] ?? [],
  );

  const deps = {
    pool: {},
    features: {
      listTestingWithTerminalRuns,
      findById: vi.fn(async (_projectId: string, featureId: string) => ({
        id: featureId,
        projectId: candidates.find((c) => c.id === featureId)?.projectId,
        status: options.featureStatus?.() ?? "testing",
      })),
      setReturned,
      updateStatus,
      setInReview,
      setAgenticReview,
    },
    jobs: { create: vi.fn(async () => ({ id: "job_review" })) },
    projects: { findById: vi.fn(async () => ({ agenticReviewEnabled: true })) },
    testRunReports: { listByFeature },
  } as unknown as TestingGateSchedulerDeps;

  return {
    deps,
    setReturned,
    updateStatus,
    setInReview,
    setAgenticReview,
    listTestingWithTerminalRuns,
    listByFeature,
  };
}

describe("runTestingGateTick", () => {
  it("counts the candidates the pre-filter offered", async () => {
    const { deps } = build([
      { id: "f1", projectId: "p1" },
      { id: "f2", projectId: "p2" },
    ]);

    const result = await runTestingGateTick(deps);

    expect(result.candidates).toBe(2);
  });

  it("resolves a stuck feature whose runs all failed without reporting", async () => {
    const { deps, updateStatus } = build([{ id: "f1", projectId: "p1" }], {
      runsByFeature: { f1: [run(), run({ jobId: "job_2", testGroup: "integration" })] },
    });

    const result = await runTestingGateTick(deps);

    expect(result.applied).toBe(1);
    expect(updateStatus).toHaveBeenCalledWith("f1", "failed");
  });

  it("does not count a feature that is still in progress", async () => {
    const { deps, updateStatus, setReturned, setAgenticReview } = build(
      [{ id: "f1", projectId: "p1" }],
      { runsByFeature: { f1: [run({ status: "running" })] } },
    );

    const result = await runTestingGateTick(deps);

    expect(result.applied).toBe(0);
    expect(updateStatus).not.toHaveBeenCalled();
    expect(setReturned).not.toHaveBeenCalled();
    expect(setAgenticReview).not.toHaveBeenCalled();
  });

  // The pre-filter is deliberately loose, so a candidate whose runs turn out to
  // be in flight (a new build dispatched between the query and the evaluation)
  // must not be advanced on stale information.
  it("re-derives the runs per candidate rather than trusting the pre-filter", async () => {
    const { deps, listByFeature } = build([{ id: "f1", projectId: "p1" }], {
      runsByFeature: { f1: [] },
    });

    const result = await runTestingGateTick(deps);

    expect(result.applied).toBe(0);
    expect(listByFeature).toHaveBeenCalledWith("f1");
  });

  // One bad candidate must not abandon the rest: that would reproduce exactly
  // the "stuck forever" failure this tick exists to prevent.
  it("keeps going when one feature fails to evaluate", async () => {
    const { deps, updateStatus, listByFeature } = build(
      [
        { id: "f1", projectId: "p1" },
        { id: "f2", projectId: "p2" },
        { id: "f3", projectId: "p3" },
      ],
      { runsByFeature: { f2: [run()], f3: [run()] } },
    );
    listByFeature.mockImplementation(async (featureId: string) => {
      if (featureId === "f1") throw new Error("database unavailable");
      return [run()];
    });

    const result = await runTestingGateTick(deps);

    expect(result.candidates).toBe(3);
    expect(result.applied).toBe(2);
    expect(updateStatus).toHaveBeenCalledTimes(2);
  });

  it("returns a feature whose report recorded failures", async () => {
    const failing = run({
      status: "completed",
      report: {
        jobId: "job_1",
        testId: null,
        passed: 3,
        failed: 1,
        skipped: 0,
        total: 4,
        coveragePercent: null,
        failingTests: ["auth rejects an expired token"],
        summary: "One unit test failed.",
        recordingPath: null,
        skipReason: null,
        createdAt: new Date(),
        steps: [],
      },
    });
    const { deps, setReturned } = build([{ id: "f1", projectId: "p1" }], {
      runsByFeature: { f1: [failing] },
    });

    await runTestingGateTick(deps);

    expect(setReturned).toHaveBeenCalledWith(
      "f1",
      "test_failure",
      expect.stringContaining("One unit test failed."),
    );
  });

  it("is idempotent: a second tick over an already-decided feature applies nothing", async () => {
    let status = "testing";
    const { deps, updateStatus } = build([{ id: "f1", projectId: "p1" }], {
      runsByFeature: { f1: [run()] },
      featureStatus: () => status,
    });

    const first = await runTestingGateTick(deps);
    // The decision moved the feature out of `testing`, which is what the second
    // tick sees — and why two replicas can run this concurrently.
    status = "failed";
    const second = await runTestingGateTick(deps);

    expect(first.applied).toBe(1);
    expect(second.applied).toBe(0);
    expect(updateStatus).toHaveBeenCalledTimes(1);
  });

  it("bounds how many features one tick looks at", async () => {
    const { deps, listTestingWithTerminalRuns } = build([]);

    await runTestingGateTick(deps);

    expect(listTestingWithTerminalRuns).toHaveBeenCalledWith(MAX_TESTING_GATE_CANDIDATES);
  });

  it("honours an explicit limit", async () => {
    const { deps, listTestingWithTerminalRuns } = build([]);

    await runTestingGateTick(deps, 3);

    expect(listTestingWithTerminalRuns).toHaveBeenCalledWith(3);
  });
});
