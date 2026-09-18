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
 *   terminal state, none reported a failure, and at least one either never
 *   produced a report at all or reported that it could not run. Sending the
 *   feature back to implementation here would be a lie — nothing was learned
 *   about the code — and it is actively harmful on an install where the cause is
 *   configuration (no `script_test_run` image, say), because every rebuild would
 *   be returned again by the same missing image, burning a build and a model
 *   call each time round. So it takes the same `failed` state as any other job
 *   that crashed (ADR 012's "structurally distinct from returned"), with the
 *   cause visible on the run itself.
 *
 * **Issue #53 adds the second way a group can fail to be verified**: a skip the
 * *installation* caused. Until then a group skipped for that reason counted as
 * verified, because a skip is reported as `passed: 0, failed: 0, skipped: 1` and
 * nothing in the report contradicted it — so a feature whose only runs were
 * skipped probes advanced to Agentic Review **having verified nothing**. See
 * `unavailableRunner` for how the two causes are told apart, and why the answer
 * had to be a field rather than a reading of the report's prose.
 *
 * Pure and dependency-free so it can be exhaustively unit-tested: this is the
 * one place that decides whether work goes back to the agent or forward to
 * review, which is exactly the kind of decision that should not need a database
 * to verify.
 */

export type TestingGateState =
  /**
   * No runs exist, and something *could* have produced one — so this is not a
   * decision, it is a wait. Either the dispatch is in flight (the state between
   * `setTesting` and the probe rows appearing) or it failed, and in both cases
   * advancing would move a feature on with nothing having checked it.
   *
   * Contrast `advance` reached from an empty run list via `nothingToVerify`,
   * which is the case issue #63 adds: no runs exist *because none were possible*
   * on this installation, and there is genuinely nothing to verify.
   */
  | "not_run"
  /** At least one run is pending or running. */
  | "in_progress"
  /** Every run reported, and none reported a failure or an install-caused skip. */
  | "advance"
  /** A run's report recorded failures. */
  | "returned"
  /**
   * Testing could not be completed: a run finished without reporting, or a group
   * was skipped because the installation could not run it. Nothing was learned
   * about the code.
   */
  | "errored";

export interface TestingGateDecision {
  state: TestingGateState;
  /**
   * Why, when the state alone does not say it. Present for `returned` and
   * `errored`, and for the `advance` that comes from `nothingToVerify` — that
   * one carries a reason because "advanced with no test runs" is otherwise
   * indistinguishable in the record from "advanced because everything passed",
   * and those are very different claims to a reader of the feature's history.
   */
  reason?: string;
}

/** Inputs beyond the run list, all defaulted so the pure decision still is. */
export interface TestingGateInputs {
  /**
   * True when this installation could not have produced *any* run for this
   * feature — no enabled Test entities, and no image for the script groups
   * (issue #63).
   *
   * Defaults to false, which is the pre-#63 behaviour and the safe direction: an
   * installation that has not reported its capabilities is treated as capable, so
   * an empty run list stays a wait rather than becoming an advance. Getting this
   * backwards would advance features on installations where testing simply had not
   * been dispatched yet.
   */
  nothingToVerify?: boolean;
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
 * Why a run makes the stage `errored` because the *installation* could not run
 * it, or null when it does not (issue #53).
 *
 * A group skipped because the repository has no `test-unit.sh`/`test-integration.sh`
 * is a project's own choice — ADR 015 item 10 makes script presence the toggle —
 * and there was genuinely nothing to verify, so that one still advances. A group
 * skipped because *this install has no `script_test_run` image* is a different
 * fact wearing the same `skipped: 1`, and advancing on it means a review over
 * work nothing checked.
 *
 * **Why the report carries this rather than the gate reading `summary`.** The
 * cause is stated in prose today ("this installation has no script_test_run image
 * configured…") and parsing it would have been the smaller change, but it is the
 * wrong mechanism three times over: issue #21 was caused by pattern-matching a
 * string where a value should have been measured; #44 rewrote this exact sentence,
 * after which a matcher keyed on its words would fail *silently*, in the direction
 * of advancing; and the counts cannot stand in for it, because a project's own
 * suite may legitimately report `total: 1, skipped: 1` for one framework-skipped
 * test. A closed enum in a column is typo-proof (a CHECK constraint) and
 * versionable, and it is the same reason the web app's load-failure copy keys on
 * an HTTP status rather than on a message.
 *
 * The reason names the group and then the report's own summary, because the side
 * that saw the cause writes a better sentence about it than this one can.
 */
function unavailableRunner(run: TestRunExecution): string | null {
  if (run.report?.skipReason !== "runner_unavailable") return null;
  const summary = run.report.summary.trim();
  return summary || `${testGroupLabel(run.testGroup)} could not run`;
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
export function decideTestingOutcome(
  runs: TestRunExecution[],
  inputs: TestingGateInputs = {},
): TestingGateDecision {
  if (runs.length === 0) {
    // Issue #63's case, and the reason it had to be distinguished rather than
    // collapsed: a feature whose only testing would have been the script probes
    // gets no runs at all on an install that cannot run them, and returning
    // `not_run` there wedges it in `testing` forever — reintroducing exactly what
    // #40 removed, by a different route. There is nothing to verify, so it
    // advances, and it says so.
    if (inputs.nothingToVerify) {
      return {
        state: "advance",
        reason:
          "No testing could be run for this feature on this installation — it has no enabled " +
          "Tests, and this installation cannot run the script test groups — so there was " +
          "nothing to verify.",
      };
    }
    return { state: "not_run" };
  }
  if (runs.some(isInFlight)) return { state: "in_progress" };

  // Real evidence about the code outranks everything else, including a group
  // that could not run: a failing assertion is the one outcome that tells the
  // agent something it can act on, and returning the feature is what puts it in
  // front of a human with the failure as the next work item.
  const failed = runs.find((run) => reportedFailure(run) !== null);
  if (failed) return { state: "returned", reason: reportedFailure(failed)! };

  // Both of the checks below end in `errored`, so their order decides only which
  // reason is reported. A skip the install caused comes first because it names a
  // *setting* an operator can change, whereas "a run ended without reporting"
  // names a symptom whose cause is only in the job's log.
  const unavailable = runs.find((run) => unavailableRunner(run) !== null);
  if (unavailable) {
    return { state: "errored", reason: unavailableRunner(unavailable)! };
  }

  const unreported = runs.find((run) => unreportedFailure(run) !== null);
  if (unreported) return { state: "errored", reason: unreportedFailure(unreported)! };

  return { state: "advance" };
}
