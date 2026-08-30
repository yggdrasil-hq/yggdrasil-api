import type pg from "pg";
import type {
  TestRunExecution,
  TestRunReport,
  TestRunStep,
  TestStepStatus,
} from "./report-types.js";

interface ReportRow {
  job_id: string;
  test_id: string | null;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  coverage_percent: string | number | null;
  failing_tests: string[];
  summary: string;
  recording_path: string | null;
  created_at: Date;
}

interface StepRow {
  job_id: string;
  name: string;
  status: TestStepStatus;
  details: string | null;
  screenshot_path: string | null;
  created_at: Date;
}

function mapStep(row: StepRow): TestRunStep {
  return {
    name: row.name,
    status: row.status,
    details: row.details,
    screenshotPath: row.screenshot_path,
    createdAt: row.created_at,
  };
}

function mapReport(row: ReportRow, steps: TestRunStep[]): TestRunReport {
  return {
    jobId: row.job_id,
    testId: row.test_id,
    passed: row.passed,
    failed: row.failed,
    skipped: row.skipped,
    total: row.total,
    coveragePercent:
      row.coverage_percent === null ? null : Number(row.coverage_percent),
    failingTests: row.failing_tests ?? [],
    summary: row.summary,
    recordingPath: row.recording_path,
    createdAt: row.created_at,
    steps,
  };
}

export class TestRunReportRepository {
  constructor(private readonly db: pg.Pool) {}

  async upsertStep(input: {
    jobId: string;
    name: string;
    status: TestStepStatus;
    details?: string;
    screenshotPath?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO test_run_steps (job_id, name, status, details, screenshot_path)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (job_id, name) DO UPDATE SET
         status = EXCLUDED.status,
         details = EXCLUDED.details,
         screenshot_path = EXCLUDED.screenshot_path`,
      [
        input.jobId,
        input.name,
        input.status,
        input.details ?? null,
        input.screenshotPath ?? null,
      ],
    );
  }

  async upsertReport(input: {
    jobId: string;
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    coveragePercent?: number;
    failingTests?: string[];
    summary: string;
    recordingPath?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO test_run_reports
         (job_id, passed, failed, skipped, total, coverage_percent, failing_tests, summary, recording_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (job_id) DO UPDATE SET
         passed = EXCLUDED.passed,
         failed = EXCLUDED.failed,
         skipped = EXCLUDED.skipped,
         total = EXCLUDED.total,
         coverage_percent = EXCLUDED.coverage_percent,
         failing_tests = EXCLUDED.failing_tests,
         summary = EXCLUDED.summary,
         recording_path = EXCLUDED.recording_path`,
      [
        input.jobId,
        input.passed,
        input.failed,
        input.skipped,
        input.total,
        input.coveragePercent ?? null,
        JSON.stringify(input.failingTests ?? []),
        input.summary,
        input.recordingPath ?? null,
      ],
    );
  }

  async findByJob(jobId: string): Promise<TestRunReport | null> {
    const reportResult = await this.db.query<ReportRow>(
      `SELECT r.job_id, j.test_id, r.passed, r.failed, r.skipped, r.total,
              r.coverage_percent, r.failing_tests, r.summary, r.recording_path,
              r.created_at
       FROM test_run_reports r
       JOIN jobs j ON j.id = r.job_id
       WHERE r.job_id = $1`,
      [jobId],
    );
    const row = reportResult.rows[0];
    if (!row) return null;
    const steps = await this.listSteps(jobId);
    return mapReport(row, steps);
  }

  async listByFeature(featureId: string): Promise<TestRunExecution[]> {
    const jobs = await this.db.query<{
      id: string;
      test_id: string | null;
      test_group: "unit" | "integration" | null;
      status: TestRunExecution["status"];
    }>(
      `SELECT id, test_id, test_group, status
       FROM jobs j
       WHERE j.feature_id = $1
         AND j.kind IN ('test_run', 'script_test_run')
         AND j.created_at >= COALESCE(
           (SELECT created_at FROM jobs
            WHERE feature_id = $1 AND kind = 'feature_build'
            ORDER BY created_at DESC LIMIT 1),
           j.created_at
         )
       ORDER BY created_at ASC`,
      [featureId],
    );
    return Promise.all(jobs.rows.map(async (job) => {
      const report = await this.findByJob(job.id);
      const steps = report?.steps ?? await this.listSteps(job.id);
      return {
        jobId: job.id,
        testId: job.test_id,
        testGroup: job.test_group,
        status: job.status,
        report,
        steps,
      };
    }));
  }

  private async listSteps(jobId: string): Promise<TestRunStep[]> {
    const result = await this.db.query<StepRow>(
      `SELECT job_id, name, status, details, screenshot_path, created_at
       FROM test_run_steps
       WHERE job_id = $1
       ORDER BY created_at ASC`,
      [jobId],
    );
    return result.rows.map(mapStep);
  }
}
