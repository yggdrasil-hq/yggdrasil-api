import type pg from "pg";

export type JobEventType =
  | "agent_text"
  | "ask_user"
  | "submit_adr"
  | "run_failed"
  | "run_cancelled";

export interface JobEvent {
  id: string;
  jobId: string;
  type: JobEventType;
  question: string | null;
  markdown: string | null;
  message: string | null;
  createdAt: Date;
}

interface JobEventRow {
  id: string;
  job_id: string;
  type: JobEventType;
  question: string | null;
  markdown: string | null;
  message: string | null;
  created_at: Date;
}

function mapJobEvent(row: JobEventRow): JobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type,
    question: row.question,
    markdown: row.markdown,
    message: row.message,
    createdAt: row.created_at,
  };
}

/**
 * Persists the curated events the Orchestrator relays from a running job's
 * Pi RPC session (ADR 006 item 8), and serves them back out to the Web app
 * (item 8's original "GET endpoint" follow-up, since landed via
 * `GET /:projectId/features/:featureId/events` in `projects/routes.ts`).
 * WebSocket relay/notifications are still not implemented — the Web app
 * polls listByJob instead.
 */
export class JobEventRepository {
  constructor(private readonly db: pg.Pool) {}

  async create(input: {
    jobId: string;
    type: JobEventType;
    question?: string;
    markdown?: string;
    message?: string;
  }): Promise<JobEvent> {
    const result = await this.db.query<JobEventRow>(
      `INSERT INTO job_events (job_id, type, question, markdown, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, job_id, type, question, markdown, message, created_at`,
      [
        input.jobId,
        input.type,
        input.question ?? null,
        input.markdown ?? null,
        input.message ?? null,
      ],
    );
    return mapJobEvent(result.rows[0]);
  }

  /** Lists a job's events in chronological order. */
  async listByJob(jobId: string): Promise<JobEvent[]> {
    const result = await this.db.query<JobEventRow>(
      `SELECT id, job_id, type, question, markdown, message, created_at
       FROM job_events
       WHERE job_id = $1
       ORDER BY created_at ASC`,
      [jobId],
    );
    return result.rows.map(mapJobEvent);
  }
}
