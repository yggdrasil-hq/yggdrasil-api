export type TestStepStatus = "pass" | "fail";

export interface TestRunStep {
  name: string;
  status: TestStepStatus;
  details: string | null;
  screenshotPath: string | null;
  createdAt: Date;
}

/**
 * Issue #53: why a group was skipped, as a closed enum rather than prose.
 *
 * The two causes are different facts and only one of them is a problem:
 *
 * - `no_script` — the repository has no `test-unit.sh`/`test-integration.sh`, so
 *   the group is off by the project's own choice (ADR 015 item 10). There was
 *   nothing to verify, and a feature with only these runs may advance.
 * - `runner_unavailable` — the installation could not run the group at all (no
 *   `script_test_run` image configured, issue #44). Nothing was verified and the
 *   install is incomplete, so advancing would mean a review over unverified work.
 *
 * Null means "the runner did not say", which the gate treats as it did before
 * this existed — see `decideTestingOutcome`. The field is therefore additive: a
 * producer that does not send it changes no outcome.
 */
export type TestRunSkipReason = "no_script" | "runner_unavailable";

export interface TestRunReport {
  jobId: string;
  testId: string | null;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  coveragePercent: number | null;
  failingTests: string[];
  summary: string;
  recordingPath: string | null;
  /** Set only when the group did not run; null when it did, or nobody said. */
  skipReason: TestRunSkipReason | null;
  createdAt: Date;
  steps: TestRunStep[];
}

export interface TestRunExecution {
  jobId: string;
  testId: string | null;
  testGroup: "unit" | "integration" | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  report: TestRunReport | null;
  steps: TestRunStep[];
  /**
   * The job's failure message, when it has one. Issue #40: a run can fail
   * without ever producing a report, and that message is the only thing that
   * says why — without it a failed row reads "failed" and nothing else.
   */
  lastError: string | null;
  /** When the run finished, so a failed row can be dated like a reported one. */
  completedAt: Date | null;
}

export interface PublicTestRunReport {
  jobId: string;
  testId: string | null;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  coveragePercent: number | null;
  failingTests: string[];
  summary: string;
  recordingPath: string | null;
  /**
   * Issue #53: why the group did not run, when the runner said. The Testing tab
   * distinguishes "this project has no unit tests" from "this install could not
   * run them", which read identically as a bare `skipped: 1` row.
   */
  skipReason: TestRunSkipReason | null;
  createdAt: string;
  steps: Array<{
    name: string;
    status: TestStepStatus;
    details: string | null;
    screenshotPath: string | null;
    createdAt: string;
  }>;
}

export function toPublicTestRunReport(report: TestRunReport): PublicTestRunReport {
  return {
    jobId: report.jobId,
    testId: report.testId,
    passed: report.passed,
    failed: report.failed,
    skipped: report.skipped,
    total: report.total,
    coveragePercent: report.coveragePercent,
    failingTests: report.failingTests,
    summary: report.summary,
    recordingPath: report.recordingPath,
    skipReason: report.skipReason,
    createdAt: report.createdAt.toISOString(),
    steps: report.steps.map((step) => ({
      name: step.name,
      status: step.status,
      details: step.details,
      screenshotPath: step.screenshotPath,
      createdAt: step.createdAt.toISOString(),
    })),
  };
}

export interface PublicTestRunExecution {
  jobId: string;
  testId: string | null;
  testGroup: "unit" | "integration" | null;
  status: TestRunExecution["status"];
  report: PublicTestRunReport | null;
  steps: PublicTestRunReport["steps"];
  /** Issue #40: why a run failed when it failed without reporting. */
  lastError: string | null;
  completedAt: string | null;
}

export function toPublicTestRunExecution(
  execution: TestRunExecution,
): PublicTestRunExecution {
  return {
    jobId: execution.jobId,
    testId: execution.testId,
    testGroup: execution.testGroup,
    status: execution.status,
    report: execution.report
      ? toPublicTestRunReport(execution.report)
      : null,
    steps: execution.steps.map((step) => ({
      name: step.name,
      status: step.status,
      details: step.details,
      screenshotPath: step.screenshotPath,
      createdAt: step.createdAt.toISOString(),
    })),
    lastError: execution.lastError,
    completedAt: execution.completedAt?.toISOString() ?? null,
  };
}
