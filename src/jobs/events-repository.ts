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
  | "submit_design"
  /**
   * Issue #27: the Orchestrator synthesized this locally to report that the
   * build's entrypoint resolved conflicts between the feature branch and its
   * base. Context for a reviewer, not a result — see the API's job-event route.
   */
  | "merge_conflicts";

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

/** A stored event plus the scope its job belongs to, for relay routing. */
interface JobEventScopeRow extends JobEventRow {
  project_id: string;
  feature_id: string | null;
}

export interface JobEventWithScope {
  event: JobEvent;
  projectId: string;
  /** Null for a job that belongs to no feature (ADR 014's project-scoped `design_grill`). */
  featureId: string | null;
}

/** The event columns, spelled once so every read returns the same shape. */
const jobEventColumns = `id, job_id, type, question, markdown, message, status, pr_url,
         summary, action_items, design_snapshot, created_at`;

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
 *
 * Also the relay's write side: `create` announces each row on the `job_events`
 * channel, and the Web app's live socket is fed from that (ADR 019). The Web
 * app still polls `listByJob` — the relay is an accelerator over it, and the
 * poll is what a client falls back to when its socket is down.
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

    // Announces the row to the live relay (ADR 019 item 6), following
    // JobMessageRepository.create's ordering argument verbatim: NOTIFY only
    // becomes visible to a LISTENer once its statement's transaction commits,
    // and pg.Pool.query auto-commits each call, so inserting first is enough —
    // a listener can never be woken for a row it cannot yet read.
    //
    // The payload is the *id*, not the event: pg_notify caps its payload at
    // 8000 bytes and events legitimately carry large markdown, summaries and
    // design snapshots, so the listener reads the row back instead.
    await this.db.query("SELECT pg_notify('job_events', $1)", [result.rows[0].id]);

    return mapJobEvent(result.rows[0]);
  }

  /** Lists a job's events in chronological order. */
  async listByJob(jobId: string): Promise<JobEvent[]> {
    const result = await this.db.query<JobEventRow>(
      `SELECT ${jobEventColumns}
       FROM job_events
       WHERE job_id = $1
       ORDER BY created_at ASC`,
      [jobId],
    );
    return result.rows.map(mapJobEvent);
  }

  /**
   * Loads one event together with the project and feature its job belongs to —
   * the lookup the live relay performs on each notification (ADR 019 item 6).
   *
   * One query rather than two, because the alternative is a notification that
   * carries enough payload to route itself, and NOTIFY's 8000-byte ceiling
   * makes that unsafe for `submit_adr`-sized events. Returns null once the job
   * is gone; the read is best-effort and a deleted job simply has nothing left
   * to deliver.
   */
  async findByIdWithScope(eventId: string): Promise<JobEventWithScope | null> {
    const result = await this.db.query<JobEventScopeRow>(
      `SELECT e.id, e.job_id, e.type, e.question, e.markdown, e.message,
         e.status, e.pr_url, e.summary, e.action_items, e.design_snapshot,
         e.created_at, j.project_id, j.feature_id
       FROM job_events e
       INNER JOIN jobs j ON j.id = e.job_id
       WHERE e.id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      event: mapJobEvent(row),
      projectId: row.project_id,
      featureId: row.feature_id,
    };
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
