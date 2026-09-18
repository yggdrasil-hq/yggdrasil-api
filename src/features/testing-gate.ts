import type { TestRunExecution } from "../tests/report-types.js";

/**
 * ADR 015 items 9-12, issue #40: the decision the Testing stage makes once its
 * runs stop changing.
 *
 * **Why this is one function.** The gate used to live inline in the
 * `submit_test_report` handler and answer one question: "has every run
 * submitted a report, and did any of them fail?" That question has two failure
 * modes, and both were observed on a real feature before this existed:
 *
 * 1. A run that never reports blocks the decision forever. The handler bailed
 *    on `reports.some(r => r === null)`, so a `script_test_run` whose container
 *    never started (an unconfigured image) left the feature sitting in
 *    `testing` with no path out — not returned, not advanced, nothing to
 *    click. The gate now asks whether the *runs* are terminal, which the jobs
 *    table already knows, rather than whether every one of them was polite.
 * 2. A failed run with no report is invisible to a tally built from reports.
 *    The tab read "0 failed" on a page whose every row was a failure, because
 *    the count summed `report.failed` and there were no reports.
 *
 * **The two failure kinds are deliberately distinct.**
 *
 * - `returned` means *the code failed a test*: at least one run produced a
 *   report and that report recorded failures. This is the input ADR 015's
 *   `returned` state exists for — the agent is dispatched to fix what broke,
 *   with the failure as its new work item, and no human has to describe it.
 * - `errored` means *testing could not be completed*: every run reached a
 *   terminal state, none reported a failure, and at least one never produced a
 *   report at all. Sending the feature back to implementation here would be a
 *   lie — nothing was learned about the code — and it is actively harmful on an
 *   install where the cause is configuration (no `script_test_run` image, say),
 *   because every rebuild would be returned again by the same missing image,
 *   burning a build and a model call each time round. So it takes the same
 *   `failed` state as any other job that crashed (ADR 012's "structurally
 *   distinct from returned"), with the cause visible on the run itself.
 *
 * Pure and dependency-free so it can be exhaustively unit-tested: this is the
 * one place that decides whether work goes back to the agent or forward to
 * review, which is exactly the kind of decision that should not need a database
 * to verify.
 */

export type TestingGateState =
  /** No runs exist at all — nothing to decide on. */
  | "not_run"
  /** At least one run is pending or running. */
  | "in_progress"
  /** Every run reported, and none reported a failure. */
  | "advance"
  /** A run's report recorded failures. */
  | "returned"
  /** Runs finished without reporting; nothing was learned about the code. */
  | "errored";

export interface TestingGateDecision {
  state: TestingGateState;
  /** Present for `returned` and `errored`, absent otherwise. */
  reason?: string;
}

/** Unit / Integration / Agentic — how a group is named in a sentence. */
export function testGroupLabel(group: TestRunExecution["testGroup"]): string {
  if (group === "unit") return "Unit tests";
  if (group === "integration") return "Integration tests";
  return "Agentic tests";
}

/** A run that is still going, so the gate must wait rather than guess. */
function isInFlight(run: TestRunExecution): boolean {
  return run.status === "pending" || run.status === "running";
}

/**
 * Why a run counts as a failure of the *code*, or null when it does not.
 *
 * A report is the only thing that can say so: it is the canonical
 * `.yggdrasil/test-report.json` the runner writes, so a non-zero `failed` is a
 * named assertion that did not hold. A run that exited non-zero without writing
 * one has told us nothing about the code, which is `errored`'s business, not
 * this function's.
 */
function reportedFailure(run: TestRunExecution): string | null {
  if (!run.report || run.report.failed <= 0) return null;

  const where = testGroupLabel(run.testGroup);
  const summary = run.report.summary.trim();
  const names = run.report.failingTests.slice(0, 5);
  const listed =
    names.length > 0
      ? `${names.join(", ")}${run.report.failingTests.length > names.length ? `, +${run.report.failingTests.length - names.length} more` : ""}`
      : null;

  // The summary is what a human wrote the test to say; the failing names are
  // what the agent needs to start from. Both when both exist, because the
  // comment is carried into the returned feature and read by two audiences.
  if (summary && listed) return `${where}: ${summary} (failing: ${listed})`;
  if (summary) return `${where}: ${summary}`;
  if (listed) return `${where}: ${run.report.failed} failing (${listed})`;
  return `${where}: ${run.report.failed} failed`;
}

/**
 * Why a run makes the stage `errored`, or null when it does not.
 *
 * Covers both ways of finishing without a report: the job failed or was
 * cancelled, and the job succeeded but wrote nothing. The second is not
 * hypothetical — a runner that exits 0 without submitting is indistinguishable
 * from a pass if it is not counted, and "the tests passed" is the one wrong
 * answer that costs the most.
 */
function unreportedFailure(run: TestRunExecution): string | null {
  if (run.report) return null;
  const where = testGroupLabel(run.testGroup);
  if (run.status === "cancelled") return `${where} were cancelled before reporting`;
  if (run.status === "completed") {
    return `${where} finished without submitting a report`;
  }
  const detail = run.lastError?.trim();
  return detail ? `${where} could not run: ${detail}` : `${where} failed before reporting`;
}

/**
 * The gate's decision. `runs` is expected in dispatch order (oldest first), so
 * the reason names the earliest failure rather than whichever the database
 * happened to return last.
 */
export function decideTestingOutcome(runs: TestRunExecution[]): TestingGateDecision {
  if (runs.length === 0) return { state: "not_run" };
  if (runs.some(isInFlight)) return { state: "in_progress" };

  const failed = runs.find((run) => reportedFailure(run) !== null);
  if (failed) return { state: "returned", reason: reportedFailure(failed)! };

  const unreported = runs.find((run) => unreportedFailure(run) !== null);
  if (unreported) return { state: "errored", reason: unreportedFailure(unreported)! };

  return { state: "advance" };
}
