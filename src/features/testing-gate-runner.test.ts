import { describe, expect, it, vi } from "vitest";
import { evaluateTestingGate, type TestingGateDeps } from "./testing-gate-runner.js";
import type { TestRunExecution } from "../tests/report-types.js";

/**
 * Issue #40: applying the gate's decision. The decision itself is unit-tested in
 * `testing-gate.test.ts`; this is the wiring — which repository call each state
 * turns into, and the idempotency that lets the reconcile tick and the event
 * path share it.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FEATURE_ID = "22222222-2222-4222-8222-222222222222";

function feature(status: string) {
  return {
    id: FEATURE_ID,
    projectId: PROJECT_ID,
    slug: "feature",
    title: "Feature",
    featureType: "normal",
    status,
    branchName: null,
    adrMarkdown: null,
    awaitingUserInput: false,
    adrApproved: true,
    prUrl: null,
    parentFeatureId: null,
    returnReason: null,
    returnComment: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function run(overrides: Partial<TestRunExecution> = {}): TestRunExecution {
  return {
    jobId: "job_1",
    testId: null,
    testGroup: "unit",
    status: "completed",
    report: null,
    steps: [],
    lastError: null,
    completedAt: new Date(),
    ...overrides,
  };
}

function report(failed: number) {
  return {
    jobId: "job_1",
    testId: null,
    passed: 1,
    failed,
    skipped: 0,
    total: 1 + failed,
    coveragePercent: null,
    failingTests: failed > 0 ? ["auth rejects an expired token"] : [],
    summary: failed > 0 ? "One unit test failed" : "",
    recordingPath: null,
    skipReason: null,
    createdAt: new Date(),
    steps: [],
  };
}

function build(overrides: {
  status?: string;
  runs?: TestRunExecution[];
  agenticReviewEnabled?: boolean;
  setAgenticReview?: ReturnType<typeof vi.fn>;
  /** Issue #63: kinds the installation has reported it cannot run. */
  unrunnable?: string[];
  /** Issue #63: the project's enabled Test entities. */
  enabledTests?: number;
  /** Issue #63: force the capability read to reject. */
  capabilitiesThrow?: boolean;
} = {}) {
  const setReturned = vi.fn(async () => null);
  const updateStatus = vi.fn(async () => null);
  const setInReview = vi.fn(async () => null);
  const setAgenticReview = overrides.setAgenticReview ?? vi.fn(async () => ({ id: FEATURE_ID }));
  const jobsCreate = vi.fn(async () => ({ id: "job_review" }));
  const findById = vi.fn(async (): Promise<ReturnType<typeof feature> | null> => feature(overrides.status ?? "testing"));
  const projectsFindById = vi.fn(async (): Promise<{ agenticReviewEnabled: boolean } | null> => ({
    agenticReviewEnabled: overrides.agenticReviewEnabled ?? true,
  }));

  const unrunnable = vi.fn(async () => new Set<string>(overrides.unrunnable ?? []));
  const listEnabledByProject = vi.fn(async () =>
    Array.from({ length: overrides.enabledTests ?? 0 }, (_, i) => ({ id: `test_${i}` })),
  );

  const deps = {
    features: { findById, setReturned, updateStatus, setInReview, setAgenticReview },
    jobs: { create: jobsCreate, listFeatureTestRuns: vi.fn(async () => []) },
    projects: { findById: projectsFindById },
    testRunReports: {
      listByFeature: vi.fn(async () => overrides.runs ?? []),
    },
    tests: { listEnabledByProject },
    capabilities: {
      unrunnable: overrides.capabilitiesThrow
        ? vi.fn(async () => {
            throw new Error("connection terminated");
          })
        : unrunnable,
    },
  } as unknown as TestingGateDeps;

  return {
    deps,
    setReturned,
    updateStatus,
    setInReview,
    setAgenticReview,
    jobsCreate,
    findById,
    projectsFindById,
    unrunnable,
    listEnabledByProject,
  };
}

describe("evaluateTestingGate", () => {
  it("advances a feature whose runs all reported cleanly", async () => {
    const { deps, setAgenticReview, jobsCreate } = build({
      runs: [run({ report: report(0) })],
    });

    const result = await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID);

    expect(result.outcome).toBe("advanced");
    expect(setAgenticReview).toHaveBeenCalledWith(FEATURE_ID);
    // The Agentic Review job is what makes the transition real rather than a
    // status change with nothing running behind it.
    expect(jobsCreate).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      kind: "agentic_review",
      featureId: FEATURE_ID,
    });
  });

  it("sends a passing feature straight to review when Agentic Review is off", async () => {
    const { deps, setInReview, setAgenticReview } = build({
      runs: [run({ report: report(0) })],
      agenticReviewEnabled: false,
    });

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("advanced");
    expect(setAgenticReview).not.toHaveBeenCalled();
    expect(setInReview).toHaveBeenCalledWith(FEATURE_ID, "");
  });

  it("returns a feature whose report recorded failures, with the reason as the comment", async () => {
    const { deps, setReturned, setAgenticReview } = build({
      runs: [run({ report: report(2) })],
    });

    const result = await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID);

    expect(result.outcome).toBe("returned");
    expect(setReturned).toHaveBeenCalledWith(
      FEATURE_ID,
      "test_failure",
      expect.stringContaining("auth rejects an expired token"),
    );
    expect(setAgenticReview).not.toHaveBeenCalled();
  });

  // ADR 012's precedent: a run that never got to test the code is a failure of
  // the environment, structurally distinct from a test that failed. Returning
  // the feature here would tell the agent to fix code nothing was learned about,
  // and would loop forever when the cause is configuration.
  it("fails a feature whose runs never reported, instead of returning it", async () => {
    const { deps, setReturned, updateStatus } = build({
      runs: [run({ status: "failed", lastError: "no image configured" })],
    });

    const result = await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID);

    expect(result.outcome).toBe("errored");
    expect(updateStatus).toHaveBeenCalledWith(FEATURE_ID, "failed");
    expect(setReturned).not.toHaveBeenCalled();
  });

  it("waits while a run is still going, touching nothing", async () => {
    const { deps, setReturned, updateStatus, setAgenticReview, setInReview } = build({
      runs: [run({ report: report(0) }), run({ status: "running" })],
    });

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("in_progress");
    expect(setReturned).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
    expect(setInReview).not.toHaveBeenCalled();
    expect(setAgenticReview).not.toHaveBeenCalled();
  });

  it("decides nothing when the feature has no test runs", async () => {
    const { deps, setAgenticReview, updateStatus } = build({ runs: [] });

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("not_run");
    expect(setAgenticReview).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  // The idempotency that lets the reconcile tick and the event path share this
  // function. Without it, a tick that ran after the feature had already advanced
  // could drag it back to `returned`.
  it("does nothing when the feature is no longer in testing", async () => {
    for (const status of ["returned", "agentic_review", "in_review", "running", "failed"]) {
      const { deps, setReturned, updateStatus, setAgenticReview, setInReview } = build({
        status,
        runs: [run({ report: report(3) })],
      });

      expect(
        (await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome,
        status,
      ).toBe("skipped");
      expect(setReturned).not.toHaveBeenCalled();
      expect(updateStatus).not.toHaveBeenCalled();
      expect(setAgenticReview).not.toHaveBeenCalled();
      expect(setInReview).not.toHaveBeenCalled();
    }
  });

  it("does nothing when the feature does not exist", async () => {
    const { deps, findById } = build();
    findById.mockResolvedValue(null);

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("skipped");
  });

  // A project row can be missing (deleted between dispatch and decision). The
  // pass is then not applied, which is the honest outcome — there is no project
  // to advance within.
  it("does not advance when the project is gone", async () => {
    const { deps, jobsCreate, projectsFindById } = build({ runs: [run({ report: report(0) })] });
    projectsFindById.mockResolvedValue(null);

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("advanced");
    expect(jobsCreate).not.toHaveBeenCalled();
  });

  /*
   * Issue #63. The gate has to tell "no runs yet" from "no runs possible", and
   * it can only do the second with the installation's capabilities plus the
   * project's enabled Tests. Each case below is one half of that pair, because
   * needing both is the part that is easy to get wrong in either direction: too
   * eager advances a feature that could have been tested, too timid trips the
   * wedge.
   */
  it("advances a feature with nothing to verify, and says why", async () => {
    const { deps, setAgenticReview, unrunnable, listEnabledByProject } = build({
      runs: [],
      unrunnable: ["script_test_run"],
      enabledTests: 0,
    });

    const result = await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID);

    expect(result.outcome).toBe("advanced");
    expect(result.reason).toContain("nothing to verify");
    expect(setAgenticReview).toHaveBeenCalledWith(FEATURE_ID);
    // Both halves of the condition were actually consulted.
    expect(unrunnable).toHaveBeenCalled();
    expect(listEnabledByProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("waits rather than advancing when the project has an enabled Test", async () => {
    // One enabled Test means `submit_build_result` dispatches a `test_run`, so a
    // run was possible and the empty list is a wait — advancing here would skip
    // a real check.
    const { deps, setAgenticReview } = build({
      runs: [],
      unrunnable: ["script_test_run"],
      enabledTests: 1,
    });

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("not_run");
    expect(setAgenticReview).not.toHaveBeenCalled();
  });

  it("waits when the installation can run the script groups", async () => {
    // Capable ⇒ the probes were dispatched ⇒ an empty list means they have not
    // reported yet.
    const { deps, setAgenticReview, listEnabledByProject } = build({
      runs: [],
      unrunnable: [],
      enabledTests: 0,
    });

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("not_run");
    expect(setAgenticReview).not.toHaveBeenCalled();
    // Short-circuits on the capability read: no reason to ask about Tests when
    // the probes are runnable.
    expect(listEnabledByProject).not.toHaveBeenCalled();
  });

  it("waits when the capability read fails, rather than advancing on an error", async () => {
    // The failure direction matters: this runs inside the reconcile tick, where
    // an exception would abandon the whole pass — so it must not become
    // "nothing to verify", which would advance a feature because a query failed.
    const { deps, setAgenticReview } = build({ runs: [], capabilitiesThrow: true });

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("not_run");
    expect(setAgenticReview).not.toHaveBeenCalled();
  });

  it("waits when no capabilities are wired at all", async () => {
    // Every caller before #63, and every deployment whose Orchestrator does not
    // publish: the null object reports nothing unrunnable, so nothing advances on
    // a capability that was never reported.
    const { deps, setAgenticReview } = build({ runs: [], enabledTests: 0 });
    delete (deps as { capabilities?: unknown }).capabilities;

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("not_run");
    expect(setAgenticReview).not.toHaveBeenCalled();
  });

  // setAgenticReview is guarded on `testing` and returns null if another path
  // already moved the feature on, so the review job must not be created anyway.
  it("does not dispatch a review job when the transition did not happen", async () => {
    const { deps, jobsCreate } = build({
      runs: [run({ report: report(0) })],
      setAgenticReview: vi.fn(async () => null),
    });

    expect((await evaluateTestingGate(deps, PROJECT_ID, FEATURE_ID)).outcome).toBe("advanced");
    expect(jobsCreate).not.toHaveBeenCalled();
  });
});
