export type TestStepStatus = "pass" | "fail";

export interface TestRunStep {
  name: string;
  status: TestStepStatus;
  details: string | null;
  screenshotPath: string | null;
  createdAt: Date;
}

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

export function toPublicTestRunExecution(execution: TestRunExecution) {
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
  };
}
