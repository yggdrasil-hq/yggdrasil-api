import type pg from "pg";
import type { JobPreview, PreviewStatus, StalePreview } from "./types.js";

interface JobPreviewRow {
  id: string;
  project_id: string;
  job_id: string;
  host: string;
  status: PreviewStatus;
  last_error: string | null;
  created_at: Date;
  torn_down_at: Date | null;
}

const previewColumns = `
    id, project_id, job_id, host, status, last_error, created_at, torn_down_at
`;

function mapPreview(row: JobPreviewRow): JobPreview {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    host: row.host,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    tornDownAt: row.torn_down_at,
  };
}

/**
 * ADR 003 §10/§15/§17: the registry of ephemeral preview deployments.
 *
 * Deliberately mutable, unlike the deploy ledger (ADR 022) — a preview has a
 * lifecycle (created → torn down, or failed), and "is a preview still holding
 * one of the project's three slots?" is a question about current state, not
 * history. The registry is therefore a mirror of the cluster's active
 * previews, not an append-only log; the durable "what happened" record is
 * audit_events (ADR 028).
 *
 * The Orchestrator is the only writer. It reports what it did to the cluster
 * rather than asking the API to decide, because the cluster is where the
 * resource actually lives — a row here is a claim about the cluster that the
 * Orchestrator owns.
 */
export class JobPreviewRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Records a preview as up, or refreshes the row for a job whose preview is
   * being (re)created. Upsert on job_id: a job has at most one preview, and
   * re-registering one that already exists — a retried step, or a
   * re-created deployment — must not fail or duplicate.
   */
  async register(input: {
    projectId: string;
    jobId: string;
    host: string;
  }): Promise<JobPreview> {
    const result = await this.db.query<JobPreviewRow>(
      `INSERT INTO job_previews (project_id, job_id, host, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (job_id) DO UPDATE
         SET host = EXCLUDED.host,
             status = 'active',
             last_error = NULL,
             torn_down_at = NULL
       RETURNING ${previewColumns}`,
      [input.projectId, input.jobId, input.host],
    );
    return mapPreview(result.rows[0]);
  }

  /**
   * Records that a preview could not be brought up. Stored rather than
   * dropped so the failure is visible to the user instead of reading as "this
   * job has no preview", and so it does not occupy a §17 slot — the cluster
   * resource it would have held was never created, or was created and torn
   * down by the caller.
   */
  async markFailed(input: {
    projectId: string;
    jobId: string;
    host: string;
    lastError: string;
  }): Promise<JobPreview> {
    const result = await this.db.query<JobPreviewRow>(
      `INSERT INTO job_previews (project_id, job_id, host, status, last_error, torn_down_at)
       VALUES ($1, $2, $3, 'failed', $4, NOW())
       ON CONFLICT (job_id) DO UPDATE
         SET host = EXCLUDED.host,
             status = 'failed',
             last_error = EXCLUDED.last_error,
             torn_down_at = NOW()
       RETURNING ${previewColumns}`,
      [input.projectId, input.jobId, input.host, input.lastError],
    );
    return mapPreview(result.rows[0]);
  }

  /**
   * Marks a preview torn down, which is what frees its §17 slot. Idempotent:
   * the normal deferred teardown and the stale sweep can both run for the same
   * preview, and the second must not be an error.
   *
   * Returns null when there is no row for the job — a preview that never
   * registered (the job failed before creating one), which callers treat as
   * success rather than a 404.
   */
  async markTornDown(jobId: string): Promise<JobPreview | null> {
    const result = await this.db.query<JobPreviewRow>(
      `UPDATE job_previews
         SET status = 'torn_down', torn_down_at = NOW()
       WHERE job_id = $1
       RETURNING ${previewColumns}`,
      [jobId],
    );
    return result.rows[0] ? mapPreview(result.rows[0]) : null;
  }

  /** A project's previews, newest first — the Web app's read path. */
  async listForProject(projectId: string): Promise<JobPreview[]> {
    const result = await this.db.query<JobPreviewRow>(
      `SELECT ${previewColumns}
         FROM job_previews
        WHERE project_id = $1
        ORDER BY created_at DESC`,
      [projectId],
    );
    return result.rows.map(mapPreview);
  }

  /** The preview for one job, if any — used to annotate a job read. */
  async findByJob(jobId: string): Promise<JobPreview | null> {
    const result = await this.db.query<JobPreviewRow>(
      `SELECT ${previewColumns} FROM job_previews WHERE job_id = $1`,
      [jobId],
    );
    return result.rows[0] ? mapPreview(result.rows[0]) : null;
  }

  /**
   * Previews the Orchestrator should remove. Two distinct reasons, both
   * necessary:
   *
   *  1. **The job is no longer running.** Its own deferred teardown did not
   *     happen — the most common cause being an Orchestrator restart between
   *     the job ending and the teardown running, or a teardown that errored.
   *     Collected immediately.
   *  2. **The preview is older than `ttlSeconds`.** This is the backstop that
   *     does not depend on the job row at all: a job that crashed hard can be
   *     left `running` forever (nothing reaps it), so a "job is terminal" test
   *     alone would never collect that preview. A TTL bounds the leak from a
   *     crash by itself, which is what makes the cleanup robust rather than
   *     merely usually-correct.
   *
   * The join is inner, so a preview whose job row has vanished is not in the
   * result — not an oversight, but a fact the schema already guarantees:
   * `job_id` is NOT NULL with ON DELETE CASCADE, so deleting a job deletes its
   * preview row too, and this query can never encounter a dangling one.
   *
   * Bounded by `limit` so a sweep after a long outage cannot try to tear down
   * thousands of releases in one call.
   */
  async listStale(input: { ttlSeconds: number; limit: number }): Promise<StalePreview[]> {
    const result = await this.db.query<{ job_id: string; project_id: string; host: string }>(
      `SELECT p.job_id, p.project_id, p.host
         FROM job_previews p
         JOIN jobs j ON j.id = p.job_id
        WHERE p.status = 'active'
          AND (
            j.status <> 'running'
            OR p.created_at < NOW() - ($1 || ' seconds')::interval
          )
        ORDER BY p.created_at ASC
        LIMIT $2`,
      [String(input.ttlSeconds), input.limit],
    );
    return result.rows.map((row) => ({
      jobId: row.job_id,
      projectId: row.project_id,
      host: row.host,
    }));
  }
}
