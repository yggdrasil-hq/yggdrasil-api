import type pg from "pg";

export type JobEventType =
  | "agent_text"
  | "ask_user"
  | "submit_adr"
  | "run_failed"
  | "run_cancelled"
  | "user_message"
  | "submit_build_result";

export interface JobEvent {
  id: string;
  jobId: string;
  type: JobEventType;
  question: string | null;
  markdown: string | null;
  message: string | null;
  status: string | null;
  prUrl: string | null;
  summary: string | null;
  createdAt: Date;
}

interface JobEventRow {
  id: string;
  job_id: string;
  type: JobEventType;
  question: string | null;
  markdown: string | null;
  message: string | null;
  status: string | null;
  pr_url: string | null;
  summary: string | null;
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
    status: row.status,
    prUrl: row.pr_url,
    summary: row.summary,
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
    status?: string;
    prUrl?: string;
    summary?: string;
  }): Promise<JobEvent> {
    const result = await this.db.query<JobEventRow>(
      `INSERT INTO job_events (job_id, type, question, markdown, message, status, pr_url, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, job_id, type, question, markdown, message, status, pr_url, summary, created_at`,
      [
        input.jobId,
        input.type,
        input.question ?? null,
        input.markdown ?? null,
        input.message ?? null,
        input.status ?? null,
        input.prUrl ?? null,
        input.summary ?? null,
      ],
    );
    return mapJobEvent(result.rows[0]);
  }

  /** Lists a job's events in chronological order. */
  async listByJob(jobId: string): Promise<JobEvent[]> {
    const result = await this.db.query<JobEventRow>(
      `SELECT id, job_id, type, question, markdown, message, status, pr_url, summary, created_at
       FROM job_events
       WHERE job_id = $1
       ORDER BY created_at ASC`,
      [jobId],
    );
    return result.rows.map(mapJobEvent);
  }
}
