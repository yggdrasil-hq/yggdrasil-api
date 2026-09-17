import type pg from "pg";
import type { RecordingContentType } from "./retention.js";
import type { JobRecording, JobRecordingContent } from "./types.js";

interface RecordingRow {
  job_id: string;
  project_id: string;
  content_type: RecordingContentType;
  byte_size: number;
  expires_at: Date;
  purged_at: Date | null;
  created_at: Date;
}

interface RecordingContentRow extends RecordingRow {
  data: Buffer | null;
}

/**
 * ADR 029's storage for test-run screen recordings.
 *
 * Bytes live in this table rather than in S3/MinIO. That is a deliberate,
 * constrained choice rather than the intended end state: **no S3 client exists
 * in this codebase** (the API has no `@aws-sdk/client-s3`, and the S3_* env
 * vars its Compose service receives are read by nothing), so the alternative
 * was a hand-rolled SigV4 client or a new dependency — neither of which belongs
 * in a feature lane. Postgres is already a hard dependency, is already where
 * every artifact's *metadata* lives, and with the size cap plus retention below
 * it is bounded.
 *
 * What makes that safe rather than reckless:
 *
 * - `maxBytes` (config, default 25 MB) refuses oversized artifacts at the door.
 * - Retention reclaims bytes on a schedule, and does so by tombstoning (see
 *   `purgeExpired`) so the table cannot grow without bound.
 * - The read paths never select `data` unless the caller asked for bytes, so a
 *   run-history listing cannot accidentally pull video into memory.
 *
 * The move to object storage is a swap of this class's two byte-touching
 * methods (`insert`'s payload and `findContent`), because everything else in
 * the feature reads metadata only. Recorded in ADR 029 as the migration path.
 */
export class JobRecordingRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Stores (or replaces) one job's recording.
   *
   * Upsert rather than insert: the Orchestrator's upload is a best-effort
   * side-channel with no exactly-once guarantee (the same posture ADR 023's
   * usage report takes), so a retried post must not fail the job or duplicate
   * the artifact. `ON CONFLICT` also means a re-upload replaces a tombstone,
   * which is the right behaviour if a project ever raises its retention.
   */
  async upsert(input: {
    jobId: string;
    projectId: string;
    contentType: RecordingContentType;
    data: Buffer;
    expiresAt: Date;
  }): Promise<JobRecording> {
    const result = await this.db.query<RecordingRow>(
      `INSERT INTO job_recordings
         (job_id, project_id, content_type, byte_size, data, expires_at, purged_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (job_id) DO UPDATE SET
         content_type = EXCLUDED.content_type,
         byte_size    = EXCLUDED.byte_size,
         data         = EXCLUDED.data,
         expires_at   = EXCLUDED.expires_at,
         purged_at    = NULL
       RETURNING job_id, project_id, content_type, byte_size, expires_at, purged_at, created_at`,
      [
        input.jobId,
        input.projectId,
        input.contentType,
        input.data.byteLength,
        input.data,
        input.expiresAt,
      ],
    );
    return mapRecording(result.rows[0]);
  }

  /** Metadata only — never pulls bytes. */
  async findByJob(jobId: string): Promise<JobRecording | null> {
    const result = await this.db.query<RecordingRow>(
      `SELECT job_id, project_id, content_type, byte_size, expires_at, purged_at, created_at
         FROM job_recordings
        WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row ? mapRecording(row) : null;
  }

  /**
   * The bytes, for the download path only. Returns the row even when `data` is
   * null, so the caller can distinguish a purged artifact (row present, no
   * bytes) from an absent one (no row) and answer 410 rather than 404.
   */
  async findContent(jobId: string): Promise<JobRecordingContent | null> {
    const result = await this.db.query<RecordingContentRow>(
      `SELECT job_id, project_id, content_type, byte_size, data, expires_at, purged_at, created_at
         FROM job_recordings
        WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...mapRecording(row), data: row.data };
  }

  /**
   * Reclaims the bytes of every recording past its expiry, keeping the rows as
   * tombstones. Returns how many artifacts were purged.
   *
   * `expires_at <= NOW()` mirrors `recordingState`'s predicate exactly (see
   * `retention.ts`) — the two are the same rule written twice, once in SQL for
   * the sweep and once in TypeScript for a read, and they must not drift.
   *
   * `LIMIT`ed and idempotent: the partial index only covers rows still holding
   * bytes, so a second pass finds nothing to do, and a backlog drains over
   * successive ticks rather than in one long transaction holding the table.
   */
  async purgeExpired(limit = 50): Promise<number> {
    const result = await this.db.query(
      `UPDATE job_recordings
          SET data = NULL, purged_at = NOW()
        WHERE job_id IN (
          SELECT job_id
            FROM job_recordings
           WHERE data IS NOT NULL
             AND expires_at <= NOW()
           ORDER BY expires_at ASC
           LIMIT $1
        )`,
      [limit],
    );
    return result.rowCount ?? 0;
  }
}

function mapRecording(row: RecordingRow): JobRecording {
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    contentType: row.content_type,
    byteSize: row.byte_size,
    expiresAt: row.expires_at,
    purgedAt: row.purged_at,
    createdAt: row.created_at,
  };
}
