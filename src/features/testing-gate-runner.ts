import type { FeatureRepository } from "./repository.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { TestRunReportRepository } from "../tests/reports-repository.js";
import type { TestRepository } from "../tests/repository.js";
import type { JobKindCapabilities } from "../jobs/capabilities.js";
import { UNKNOWN_CAPABILITIES } from "../jobs/capabilities.js";
import { decideTestingOutcome } from "./testing-gate.js";

export interface TestingGateDeps {
  features: FeatureRepository;
  jobs: JobRepository;
  projects: ProjectRepository;
  testRunReports: TestRunReportRepository;
  /** Issue #63: the project's enabled Test entities, for the "nothing to verify" check. */
  tests: TestRepository;
  /**
   * Issue #63: what the installation can run. Optional, defaulting to the null
   * object — every existing caller then behaves exactly as it did before this
   * existed, and a deployment whose Orchestrator does not publish is unaffected.
   */
  capabilities?: JobKindCapabilities;
}

export interface TestingGateResult {
  /** What the gate decided, or `skipped` when the feature was not in `testing`. */
  outcome: "skipped" | "not_run" | "in_progress" | "advanced" | "returned" | "errored";
  reason?: string;
}

/**
 * ADR 015 items 9-12, issue #40: evaluates a feature's Testing stage and applies
 * the decision.
 *
 * Called from two places, and it has to be safe from both:
 *
 * - the `submit_test_report` handler, the ordinary path — the last runner to
 *   report decides;
 * - the reconcile tick (`testing-gate-reconcile.ts`), which exists because a run
 *   can finish without ever reporting. Nothing otherwise wakes the gate up in
 *   that case, which is how a feature used to sit in `testing` indefinitely.
 *
 * **Re-reading the feature is what makes it idempotent.** A decision moves the
 * feature out of `testing`, so a second evaluation — a duplicate event, two
 * replicas evaluating the same feature on the same tick — finds it elsewhere
 * and does nothing. Without that guard the gate could push a feature that had
 * already advanced to `agentic_review` back to `returned`.
 */
export async function evaluateTestingGate(
  deps: TestingGateDeps,
  projectId: string,
  featureId: string,
): Promise<TestingGateResult> {
  const feature = await deps.features.findById(projectId, featureId);
  if (!feature || feature.status !== "testing") return { outcome: "skipped" };

  const runs = await deps.testRunReports.listByFeature(featureId);
  const decision = decideTestingOutcome(runs, {
    nothingToVerify:
      runs.length === 0 ? await couldNotHaveProducedARun(deps, projectId) : false,
  });

  switch (decision.state) {
    case "not_run":
      // Nothing to gate on *yet*. Advancing would send a feature to review that
      // was never tested; returning it would send back work nothing was learned
      // about. The Testing tab's empty state is the honest surface for this.
      //
      // (This is reachable only when a run *could* have existed — the dispatch is
      // in flight or it failed. Issue #63's "no runs because none were possible"
      // takes the `advance` branch below instead.)
      return { outcome: "not_run" };

    case "in_progress":
      return { outcome: "in_progress" };

    case "returned":
      // ADR 015 item 15: `returned` with `test_failure`, which is what puts a
      // "Resume implementation" action in front of a human and seeds the next
      // build with the failure as its work item. Reused rather than
      // parallel-mechanised, per ADR 015's own instruction.
      await deps.features.setReturned(featureId, "test_failure", decision.reason ?? "");
      return { outcome: "returned", reason: decision.reason };

    case "errored":
      await deps.features.updateStatus(featureId, "failed");
      return { outcome: "errored", reason: decision.reason };

    case "advance":
    default:
      // An advance with a reason is the "nothing to verify" case (issue #63), and
      // it is worth a log line rather than being silent: the feature moves to
      // review having run no tests at all, so "why was this not tested?" needs an
      // answer somewhere. There is no column for an advance's reason — unlike
      // `returned`, which carries its comment — so the operator-visible record is
      // this line and the Testing tab's own empty state.
      if (decision.reason) {
        console.log(
          `testing gate: advancing feature ${featureId} with no test runs — ${decision.reason}`,
        );
      }
      await advanceAfterTesting(deps, projectId, featureId);
      // Carried through either way: an advance from an empty run list is a
      // different claim from an advance after passing tests, and the caller
      // should not have to re-derive which happened.
      return { outcome: "advanced", reason: decision.reason };
  }
}

/**
 * Issue #63: whether this installation could have produced *any* run for this
 * feature, so an empty run list can be told apart from a pending one.
 *
 * Both halves have to be absent for the answer to be yes, and each is checked
 * from the service that owns it:
 *
 * - **Enabled Test entities.** Owned by the API (`tests`), so this is a query
 *   rather than a signal. `submit_build_result` dispatches one `test_run` per
 *   enabled Test, so any enabled Test means a run was possible.
 * - **The script groups.** Owned by the *Orchestrator*, which is why this needs
 *   `capabilities`: the API cannot see whether an image exists, and ADR 015 item
 *   10 makes script presence, not a project setting, the toggle. `script_test_run`
 *   is the kind that gates both the `unit` and `integration` probes — they are
 *   two dispatches of one kind.
 *
 * **Unknown capabilities answer "a run was possible".** `UNKNOWN_CAPABILITIES`
 * reports nothing unrunnable, so an install that has not published behaves
 * exactly as it did before #63 — and, more importantly, the failure direction is
 * the safe one: a probe that cannot run is *visible* (it is reported, and #53 made
 * the gate fail on it), whereas advancing a feature because the API merely did not
 * know it could have tested it loses the check silently.
 *
 * A failure to read capabilities is treated the same way, and for the same
 * reason. This runs inside the reconcile tick, where an exception would abandon
 * the whole pass (see `runTestingGateTick`), so a transient database error must
 * not become "nothing to verify" — that would advance a feature on the strength
 * of an error.
 */
async function couldNotHaveProducedARun(
  deps: TestingGateDeps,
  projectId: string,
): Promise<boolean> {
  const capabilities = deps.capabilities ?? UNKNOWN_CAPABILITIES;

  let unrunnable: ReadonlySet<string>;
  try {
    unrunnable = await capabilities.unrunnable();
  } catch (error) {
    console.error(
      `testing gate: could not read installation capabilities for project ${projectId}; ` +
        `treating every job kind as runnable so nothing is advanced on a failed read:`,
      error,
    );
    return false;
  }
  if (!unrunnable.has("script_test_run")) return false;

  const enabledTests = await deps.tests.listEnabledByProject(projectId);
  return enabledTests.length === 0;
}

/**
 * ADR 015 item 12: a passed Testing stage goes to Agentic Review when the
 * project has that gate on, and straight to Manual Review (`in_review`) when it
 * does not. Moved here from `jobs/internal-routes.ts` unchanged so the event
 * path and the reconcile tick share one definition of "what happens on a pass".
 */
export async function advanceAfterTesting(
  deps: Pick<TestingGateDeps, "features" | "jobs" | "projects">,
  projectId: string,
  featureId: string,
): Promise<void> {
  const project = await deps.projects.findById(projectId);
  if (!project) return;
  if (!project.agenticReviewEnabled) {
    await deps.features.setInReview(featureId, "");
    return;
  }
  const advanced = await deps.features.setAgenticReview(featureId);
  if (!advanced) return;
  await deps.jobs.create({
    projectId,
    kind: "agentic_review",
    featureId,
  });
}
