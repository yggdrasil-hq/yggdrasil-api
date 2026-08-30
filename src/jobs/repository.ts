import type pg from "pg";
import type { Job, JobKind, JobStatus } from "./types.js";

interface JobRow {
  id: string;
  project_id: string;
  kind: JobKind;
  feature_id: string | null;
  test_id: string | null;
  ref: string | null;
  trigger_source: "feature" | "schedule" | null;
  design_name: string | null;
  design_slug: string | null;
  design_description: string | null;
  status: JobStatus;
  last_error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

const jobColumns = `
    id, project_id, kind, feature_id, test_id, ref, trigger_source,
    design_name, design_slug, design_description,
    status, last_error, created_at, started_at, completed_at
`;

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    featureId: row.feature_id,
    testId: row.test_id,
    ref: row.ref,
    trigger: row.trigger_source,
    designName: row.design_name,
    designSlug: row.design_slug,
    designDescription: row.design_description,
    status: row.status,
    lastError: row.last_error,
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
    ref?: string;
    trigger?: "feature" | "schedule";
    designName?: string;
    designSlug?: string;
    designDescription?: string;
  }): Promise<Job> {
    const result = await this.db.query<JobRow>(
      `INSERT INTO jobs
         (project_id, kind, feature_id, test_id, ref, trigger_source,
          design_name, design_slug, design_description, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING ${jobColumns}`,
      [
        input.projectId,
        input.kind,
        input.featureId ?? null,
        input.testId ?? null,
        input.ref ?? (input.kind === "test_run" ? "main" : null),
        input.trigger ?? (input.kind === "test_run" ? "schedule" : null),
        input.designName ?? null,
        input.designSlug ?? null,
        input.designDescription ?? null,
      ],
    );
    return mapJob(result.rows[0]);
  }

  /**
   * Looks up a job by id, used by the internal job-events endpoint to
   * resolve which feature (if any) an incoming curated event belongs to,
   * so it can flip `awaiting_user_input` (ADR 006 item 10).
   */
  async findById(jobId: string): Promise<Job | null> {
    const result = await this.db.query<JobRow>(
      `SELECT ${jobColumns}
       FROM jobs
       WHERE id = $1`,
      [jobId],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async findByIdForProject(projectId: string, jobId: string): Promise<Job | null> {
    const result = await this.db.query<JobRow>(
      `SELECT ${jobColumns}
       FROM jobs
       WHERE project_id = $1 AND id = $2`,
      [projectId, jobId],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  async hasActiveTestRunsForProject(projectId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM jobs
         WHERE project_id = $1
           AND kind = 'test_run'
           AND status IN ('pending', 'running')
       ) AS exists`,
      [projectId],
    );
    return result.rows[0]?.exists ?? false;
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

  async hasActiveFeatureTestRuns(featureId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM jobs
         WHERE feature_id = $1
           AND kind = 'test_run'
           AND status IN ('pending', 'running')
       ) AS exists`,
      [featureId],
    );
    return result.rows[0]?.exists ?? false;
  }

  async listFeatureTestRuns(featureId: string): Promise<Job[]> {
    const result = await this.db.query<JobRow>(
      `SELECT ${jobColumns}
       FROM jobs j
       WHERE j.feature_id = $1
         AND j.kind = 'test_run'
         AND j.created_at >= COALESCE(
           (SELECT created_at FROM jobs
            WHERE feature_id = $1 AND kind = 'feature_build'
            ORDER BY created_at DESC LIMIT 1),
           j.created_at
         )
       ORDER BY created_at ASC`,
      [featureId],
    );
    return result.rows.map(mapJob);
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

  /**
   * Finds the running spec_grill job for a feature, if any — the target
   * for a human's reply to an in-progress grill (ADR 006 items 9-10).
   * `null` (not an error) means there's nothing currently waiting on a
   * reply for this feature: the grill hasn't started, already finished, or
   * failed.
   */
  async findActiveSpecGrillJob(featureId: string): Promise<Job | null> {
    const result = await this.db.query<JobRow>(
      `SELECT ${jobColumns}
       FROM jobs
       WHERE feature_id = $1
         AND kind = 'spec_grill'
         AND status = 'running'
       ORDER BY created_at DESC
       LIMIT 1`,
      [featureId],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  /**
   * Finds a project's most recent job of a given kind, regardless of
   * status — the project-level counterpart to `findLatestJob` (which is
   * feature-scoped). Used for `deploy` jobs specifically: they carry no
   * `feature_id` (they're triggered by a push to `main` or a project
   * going `ready`, not tied to any one feature), so this is the only way
   * to answer "what's this project's current/most recent deploy status."
   */
  async findLatestByProjectAndKind(projectId: string, kind: JobKind): Promise<Job | null> {
    const result = await this.db.query<JobRow>(
      `SELECT ${jobColumns}
       FROM jobs
       WHERE project_id = $1 AND kind = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId, kind],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  /**
   * Finds a feature's most recent job of any kind, regardless of status —
   * used by the user-facing events endpoint (`GET
   * /:projectId/features/:featureId/events`) so the Web app can show a
   * feature's current/most recent run and its outcome, whichever phase
   * dispatched it (spec_grill's grill conversation, or feature_build's
   * build progress/result) — not just while it's running. A feature only
   * ever has one phase active at a time, so "latest job of any kind" always
   * resolves to whichever phase is (or was most recently) current.
   */
  async findLatestJob(featureId: string): Promise<Job | null> {
    const result = await this.db.query<JobRow>(
      `SELECT ${jobColumns}
       FROM jobs
       WHERE feature_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [featureId],
    );
    return result.rows[0] ? mapJob(result.rows[0]) : null;
  }

  /**
   * Marks a running job cancelled and notifies the Orchestrator via
   * Postgres LISTEN/NOTIFY on 'job_cancellations' (ADR 006's cancel/abort
   * follow-up) — insert-then-notify, mirroring
   * JobMessageRepository.create's own reasoning about NOTIFY visibility.
   * Only transitions from 'running' (guarded in SQL), so a job that
   * finished on its own between the caller's own check and this call can't
   * be clobbered back to 'cancelled'. Returns false (not an error) if
   * nothing was actually running to cancel.
   */
  async cancel(jobId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE jobs
       SET status = 'cancelled', completed_at = now()
       WHERE id = $1 AND status = 'running'`,
      [jobId],
    );
    if (result.rowCount === 0) {
      return false;
    }
    await this.db.query("SELECT pg_notify('job_cancellations', $1)", [jobId]);
    return true;
  }
}
