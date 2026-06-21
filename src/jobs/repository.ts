import type pg from "pg";
import type { Job, JobKind, JobStatus } from "./types.js";

interface JobRow {
  id: string;
  project_id: string;
  kind: JobKind;
  feature_id: string | null;
  test_id: string | null;
  status: JobStatus;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

const jobColumns = `
  id, project_id, kind, feature_id, test_id, status, created_at, started_at, completed_at
`;

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    featureId: row.feature_id,
    testId: row.test_id,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export class JobRepository {
  constructor(private readonly db: pg.Pool) {}

  async create(input: {
    projectId: string;
    kind: JobKind;
    featureId?: string;
    testId?: string;
  }): Promise<Job> {
    const result = await this.db.query<JobRow>(
      `INSERT INTO jobs (project_id, kind, feature_id, test_id, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING ${jobColumns}`,
      [
        input.projectId,
        input.kind,
        input.featureId ?? null,
        input.testId ?? null,
      ],
    );
    return mapJob(result.rows[0]);
  }

  async hasActiveTestRun(testId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM jobs
         WHERE test_id = $1
           AND kind = 'test_run'
           AND status IN ('pending', 'running')
       ) AS exists`,
      [testId],
    );
    return result.rows[0]?.exists ?? false;
  }

  async listRecentFailedTestRuns(projectId: string): Promise<Job[]> {
    const result = await this.db.query<JobRow>(
      `SELECT ${jobColumns}
       FROM jobs
       WHERE project_id = $1
         AND kind = 'test_run'
         AND status = 'failed'
       ORDER BY completed_at DESC NULLS LAST, created_at DESC
       LIMIT 20`,
      [projectId],
    );
    return result.rows.map(mapJob);
  }
}
