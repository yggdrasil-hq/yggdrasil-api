import type pg from "pg";

export type JobEventType =
  | "agent_text"
  | "ask_user"
  | "submit_adr"
  | "run_failed"
  | "run_cancelled"
  | "user_message"
  | "submit_build_result"
  | "run_started"
  | "request_action_item"
  | "submit_review"
  | "report_test_step"
  | "submit_test_report"
  | "update_design_preview"
  | "submit_design";

export interface JobEventActionItem {
  type: string;
  description: string;
  secretKey?: string;
  draftTestMarkdown?: string;
}

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
  actionItems: JobEventActionItem[] | null;
  snapshot: Record<string, string> | null;
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
  action_items: JobEventActionItem[] | null;
  design_snapshot: Record<string, string> | null;
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
    actionItems: row.action_items,
    snapshot: row.design_snapshot,
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
    actionItems?: JobEventActionItem[];
    snapshot?: Record<string, string>;
  }): Promise<JobEvent> {
    const result = await this.db.query<JobEventRow>(
      `INSERT INTO job_events
         (job_id, type, question, markdown, message, status, pr_url, summary, action_items, design_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, job_id, type, question, markdown, message, status, pr_url,
         summary, action_items, design_snapshot, created_at`,
      [
        input.jobId,
        input.type,
        input.question ?? null,
        input.markdown ?? null,
        input.message ?? null,
        input.status ?? null,
        input.prUrl ?? null,
        input.summary ?? null,
        input.actionItems ?? null,
        input.snapshot ?? null,
      ],
    );
    return mapJobEvent(result.rows[0]);
  }

  /** Lists a job's events in chronological order. */
  async listByJob(jobId: string): Promise<JobEvent[]> {
    const result = await this.db.query<JobEventRow>(
      `SELECT id, job_id, type, question, markdown, message, status, pr_url,
         summary, action_items, design_snapshot, created_at
       FROM job_events
       WHERE job_id = $1
       ORDER BY created_at ASC`,
      [jobId],
    );
    return result.rows.map(mapJobEvent);
  }

  /** Lists events from a feature's spec_grill runs for kickback context. */
  async listSpecGrillByFeature(featureId: string): Promise<JobEvent[]> {
    const result = await this.db.query<JobEventRow>(
      `SELECT e.id, e.job_id, e.type, e.question, e.markdown, e.message,
         e.status, e.pr_url, e.summary, e.action_items, e.design_snapshot,
         e.created_at
       FROM job_events e
       INNER JOIN jobs j ON j.id = e.job_id
       WHERE j.feature_id = $1 AND j.kind = 'spec_grill'
       ORDER BY e.created_at ASC`,
      [featureId],
    );
    return result.rows.map(mapJobEvent);
  }
}
