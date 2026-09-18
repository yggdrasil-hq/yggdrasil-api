import type { FeatureRepository } from "./repository.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { TestRunReportRepository } from "../tests/reports-repository.js";
import { decideTestingOutcome } from "./testing-gate.js";

export interface TestingGateDeps {
  features: FeatureRepository;
  jobs: JobRepository;
  projects: ProjectRepository;
  testRunReports: TestRunReportRepository;
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
  const decision = decideTestingOutcome(runs);

  switch (decision.state) {
    case "not_run":
      // Nothing to gate on. Advancing would send a feature to review that was
      // never tested; returning it would send back work nothing was learned
      // about. The Testing tab's empty state is the honest surface for this.
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
      await advanceAfterTesting(deps, projectId, featureId);
      return { outcome: "advanced" };
  }
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
