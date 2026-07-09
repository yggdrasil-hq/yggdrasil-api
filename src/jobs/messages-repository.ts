import type pg from "pg";

export interface JobMessage {
  id: string;
  jobId: string;
  content: string;
  createdAt: Date;
  deliveredAt: Date | null;
}

interface JobMessageRow {
  id: string;
  job_id: string;
  content: string;
  created_at: Date;
  delivered_at: Date | null;
}

function mapJobMessage(row: JobMessageRow): JobMessage {
  return {
    id: row.id,
    jobId: row.job_id,
    content: row.content,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

/**
 * Queues a human's reply to a running spec_grill job's ask_user question
 * (ADR 006 items 9-10). Inserting a row and notifying on 'job_replies' are
 * two statements rather than one transaction — Postgres NOTIFY only
 * becomes visible to LISTENers once its statement's transaction commits,
 * and pg.Pool.query auto-commits each call, so ordering (insert first) is
 * enough: a listener can never observe the notification before the row it
 * announces is already readable.
 */
export class JobMessageRepository {
  constructor(private readonly db: pg.Pool) {}

  async create(input: { jobId: string; content: string }): Promise<JobMessage> {
    const result = await this.db.query<JobMessageRow>(
      `INSERT INTO job_messages (job_id, content)
       VALUES ($1, $2)
       RETURNING id, job_id, content, created_at, delivered_at`,
      [input.jobId, input.content],
    );
    await this.db.query("SELECT pg_notify('job_replies', $1)", [input.jobId]);
    return mapJobMessage(result.rows[0]);
  }
}
