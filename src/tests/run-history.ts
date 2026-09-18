import type { JobStatus, JobTriggerSource } from "../jobs/types.js";
import type { TestRunReport, TestRunStep } from "./report-types.js";

/**
 * ADR 026: one entry in a **Test entity's** run history.
 *
 * Deliberately its own type rather than a reuse of ADR 015's `TestRunExecution`
 * (the per-*feature* Testing tab's shape). The two answer genuinely different
 * questions — "how has this scheduled test suite been doing over time" versus
 * "did this feature's branch pass its tests before review" — and they differ in
 * exactly the fields that matter here: history entries carry the triggering
 * context (`trigger`, `ref`) and the job's timing (`createdAt`/`startedAt`/
 * `completedAt`) so the UI can show duration and whether a run was scheduled or
 * came from a feature. Folding those into the feature type would mutate an
 * ADR 015 response to serve an unrelated screen.
 *
 * `report` is null for a run that has not reported yet (still running, or
 * failed before it could submit) — which is why `steps` is also carried
 * top-level: a partially-reported run still has steps worth showing.
 */
export interface TestRunHistoryEntry {
  jobId: string;
  testId: string;
  status: JobStatus;
  trigger: JobTriggerSource | null;
  testGroup: "unit" | "integration" | null;
  ref: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  report: TestRunReport | null;
  steps: TestRunStep[];
}

export interface PublicTestRunHistoryEntry {
  jobId: string;
  testId: string;
  status: JobStatus;
  trigger: JobTriggerSource | null;
  testGroup: "unit" | "integration" | null;
  ref: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Wall-clock duration, or null while the run has not finished. */
  durationMs: number | null;
  report: {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    coveragePercent: number | null;
    failingTests: string[];
    summary: string;
    recordingPath: string | null;
    createdAt: string;
  } | null;
  steps: Array<{
    name: string;
    status: TestRunStep["status"];
    details: string | null;
    screenshotPath: string | null;
    createdAt: string;
  }>;
}

/**
 * Duration is derived here rather than in the Web app so both surfaces that
 * ever show it agree, and so the "still running" case (no `completedAt`) is one
 * decision in one place — null, not a growing number measured against a clock
 * the API does not control.
 */
function durationMs(entry: TestRunHistoryEntry): number | null {
  if (!entry.startedAt || !entry.completedAt) return null;
  return entry.completedAt.getTime() - entry.startedAt.getTime();
}

export function toPublicTestRunHistoryEntry(
  entry: TestRunHistoryEntry,
): PublicTestRunHistoryEntry {
  return {
    jobId: entry.jobId,
    testId: entry.testId,
    status: entry.status,
    trigger: entry.trigger,
    testGroup: entry.testGroup,
    ref: entry.ref,
    createdAt: entry.createdAt.toISOString(),
    startedAt: entry.startedAt?.toISOString() ?? null,
    completedAt: entry.completedAt?.toISOString() ?? null,
    durationMs: durationMs(entry),
    report: entry.report
      ? {
          passed: entry.report.passed,
          failed: entry.report.failed,
          skipped: entry.report.skipped,
          total: entry.report.total,
          coveragePercent: entry.report.coveragePercent,
          failingTests: entry.report.failingTests,
          summary: entry.report.summary,
          recordingPath: entry.report.recordingPath,
          createdAt: entry.report.createdAt.toISOString(),
        }
      : null,
    steps: entry.steps.map((step) => ({
      name: step.name,
      status: step.status,
      details: step.details,
      screenshotPath: step.screenshotPath,
      createdAt: step.createdAt.toISOString(),
    })),
  };
}
