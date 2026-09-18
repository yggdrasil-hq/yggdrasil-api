import type pg from "pg";
import { recordingKey } from "../storage/keys.js";
import type { ObjectStorage } from "../storage/client.js";
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
  storage_backend: StorageBackend;
  object_key: string | null;
}

interface RecordingContentRow extends RecordingRow {
  data: Buffer | null;
}

type StorageBackend = "postgres" | "object";

/**
 * ADR 029's storage for test-run screen recordings, on either backend (issue
 * #30).
 *
 * **The two byte-touching methods are the seam, and that is now real rather than
 * planned.** ADR 029 recorded this class as the migration path: "a swap of this
 * class's two byte-touching methods (`insert`'s payload and `findContent`)".
 * That is what happened — `upsert` and `findContent` dispatch on
 * `storage_backend`, and every other method in the class (and every route,
 * sweeper and type above it) is unchanged. The one method that grew beyond the
 * seam is `purgeExpired`, which necessarily does, because reclaiming an object
 * is a network call rather than an `UPDATE` and so has a failure mode that
 * reclaiming a column does not.
 *
 * **Which backend is used is decided per row, not per process.** A row written
 * before object storage was configured keeps its bytes in `data` and is served
 * from there forever; a row written after goes to the bucket. That is what makes
 * this additive: `storage` being absent, or being present, never invalidates a
 * row that already exists, and an install that never configures a bucket behaves
 * exactly as it did before this change.
 *
 * The class is handed the client rather than constructing one, so a test can
 * pass a real client pointed at MinIO (which is what the contract tests do) or
 * omit it entirely (which is what every other test does, unchanged).
 */
export class JobRecordingRepository {
  constructor(
    private readonly db: pg.Pool,
    private readonly storage: ObjectStorage | null = null,
  ) {}

  /**
   * Stores (or replaces) one job's recording.
   *
   * Upsert rather than insert: the Orchestrator's upload is a best-effort
   * side-channel with no exactly-once guarantee (the same posture ADR 023's
   * usage report takes), so a retried post must not fail the job or duplicate
   * the artifact. `ON CONFLICT` also means a re-upload replaces a tombstone,
   * which is the right behaviour if a project ever raises its retention.
   *
   * **The object is written before the row, and removed again if the row fails.**
   * The ordering is not arbitrary: writing the row first would leave a window in
   * which the database claims bytes that do not exist, which a reader would see
   * as a broken player — the exact failure ADR 029 item 6 exists to avoid. This
   * order can instead leave an unreferenced object, so the catch block deletes it.
   * If that cleanup also fails the object is orphaned, which is invisible to a
   * user and reclaimable by deleting the prefix; the inverse mistake is visible
   * to them, so this is the ordering that errs in the recoverable direction.
   */
  async upsert(input: {
    jobId: string;
    projectId: string;
    contentType: RecordingContentType;
    data: Buffer;
    expiresAt: Date;
  }): Promise<JobRecording> {
    const backend: StorageBackend = this.storage ? "object" : "postgres";
    const key = this.storage
      ? recordingKey({
          projectId: input.projectId,
          jobId: input.jobId,
          contentType: input.contentType,
        })
      : null;

    if (this.storage && key) {
      await this.storage.putObject({
        key,
        body: input.data,
        contentType: input.contentType,
      });
    }

    try {
      const result = await this.db.query<RecordingRow>(
        `INSERT INTO job_recordings
           (job_id, project_id, content_type, byte_size, data, expires_at, purged_at,
            storage_backend, object_key)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)
         ON CONFLICT (job_id) DO UPDATE SET
           content_type    = EXCLUDED.content_type,
           byte_size       = EXCLUDED.byte_size,
           data            = EXCLUDED.data,
           expires_at      = EXCLUDED.expires_at,
           purged_at       = NULL,
           storage_backend = EXCLUDED.storage_backend,
           object_key      = EXCLUDED.object_key
         RETURNING ${recordingColumns}`,
        [
          input.jobId,
          input.projectId,
          input.contentType,
          input.data.byteLength,
          // Mutually exclusive with object_key, and the CHECK enforces it: the
          // bytes live in exactly one place.
          backend === "postgres" ? input.data : null,
          input.expiresAt,
          backend,
          key,
        ],
      );
      return mapRecording(result.rows[0]!);
    } catch (error) {
      if (this.storage && key) {
        // Best-effort: the row is what a reader resolves, so an orphaned object
        // is preferable to a dangling row, but leaving one behind on every
        // failed insert would grow the bucket silently.
        try {
          await this.storage.deleteObject(key);
        } catch (cleanupError) {
          console.error(
            `failed to clean up object ${key} after a failed recording insert: ` +
              `${String(cleanupError)} — this object is now unreferenced`,
          );
        }
      }
      throw error;
    }
  }

  /** Metadata only — never pulls bytes, from either backend. */
  async findByJob(jobId: string): Promise<JobRecording | null> {
    const result = await this.db.query<RecordingRow>(
      `SELECT ${recordingColumns}
         FROM job_recordings
        WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row ? mapRecording(row) : null;
  }

  /**
   * The bytes, for the download path only.
   *
   * Returns the row with `data: null` for a purged artifact, so the caller can
   * distinguish a purged recording (row present, no bytes) from an absent one
   * (no row) and answer 410 rather than 404 — the contract the route relies on,
   * and the reason `data` is nullable in the first place.
   *
   * **A live object-backed row whose object is missing returns `data: null`
   * too, and that is a lie of omission the log line owns up to.** The
   * alternative — throwing — would turn a missing artifact into a 500 on a page
   * whose honest answer is "we no longer have this"; and treating it as 404
   * would claim the run was never recorded. It is logged at error level because
   * it means the bucket lost something the database still believes it has, which
   * is worth someone knowing about and is not something a user can act on.
   */
  async findContent(jobId: string): Promise<JobRecordingContent | null> {
    const result = await this.db.query<RecordingContentRow>(
      `SELECT ${recordingColumns}, data
         FROM job_recordings
        WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) return null;

    if (row.storage_backend === "postgres" || row.object_key === null) {
      return { ...mapRecording(row), data: row.data };
    }

    if (row.purged_at !== null) {
      // Tombstoned before reading; no need to ask the bucket.
      return { ...mapRecording(row), data: null };
    }

    const bytes = await this.storage!.getObject(row.object_key);
    if (bytes === null) {
      console.error(
        `recording for job ${jobId} is recorded as stored at ${row.object_key}, ` +
          `but that object does not exist — the artifact is unrecoverable`,
      );
    }
    return { ...mapRecording(row), data: bytes };
  }

  /**
   * Reclaims the bytes of every recording past its expiry, keeping the rows as
   * tombstones. Returns how many artifacts were reclaimed.
   *
   * `expires_at <= NOW()` mirrors `recordingState`'s predicate exactly (see
   * `retention.ts`) — the two are the same rule written twice, once in SQL for
   * the sweep and once in TypeScript for a read, and they must not drift.
   *
   * ## Why this method is no longer one `UPDATE`
   *
   * On object storage, reclaiming bytes is a network call, and a network call
   * can fail halfway through a batch. So the two backends are reclaimed
   * **independently** rather than in one pass:
   *
   * - a `postgres` row is tombstoned unconditionally — nulling the column needs
   *   nothing external to succeed, today exactly as before;
   * - an `object` row is tombstoned **only after its object is gone**. A failed
   *   delete leaves the row untouched, so the next tick retries it, and the
   *   partial index still considers it reclaimable (its `object_key` is still
   *   set). The alternative — tombstoning anyway — would record "reclaimed"
   *   while leaving the bytes in the bucket, and nothing would ever try again.
   *
   * The visible consequence is that an unreachable bucket stalls object
   * reclamation and logs it, rather than silently reporting success. That is the
   * honest failure, and reads stay correct throughout: an expired recording
   * answers 410 from its `expires_at` whether or not its bytes have been
   * reclaimed yet.
   *
   * `LIMIT`ed and idempotent, as before: the partial index only covers rows still
   * holding bytes, a second pass finds nothing, and a backlog drains over
   * successive ticks rather than in one long transaction.
   */
  async purgeExpired(limit = 50): Promise<number> {
    const candidates = await this.db.query<{
      job_id: string;
      storage_backend: StorageBackend;
      object_key: string | null;
    }>(
      `SELECT job_id, storage_backend, object_key
         FROM job_recordings
        WHERE (data IS NOT NULL OR object_key IS NOT NULL)
          AND expires_at <= NOW()
        ORDER BY expires_at ASC
        LIMIT $1`,
      [limit],
    );
    if (candidates.rows.length === 0) return 0;

    const reclaimableInDatabase: string[] = [];
    const reclaimedInStorage: string[] = [];

    for (const row of candidates.rows) {
      if (row.storage_backend === "postgres") {
        reclaimableInDatabase.push(row.job_id);
        continue;
      }
      if (!this.storage || row.object_key === null) {
        // An object-backed row with no client means the deployment dropped its
        // storage configuration while rows still point at it. Logged rather
        // than tombstoned: the bytes are out there and this process cannot
        // reach them, which is exactly the state a later configuration change
        // can still clean up. Tombstoning would forget them.
        console.error(
          `recording for job ${row.job_id} is in object storage at ${row.object_key}, ` +
            `but no object storage is configured — leaving it reclaimable`,
        );
        continue;
      }
      try {
        await this.storage.deleteObject(row.object_key);
        reclaimedInStorage.push(row.job_id);
      } catch (error) {
        console.error(
          `failed to delete object ${row.object_key} for job ${row.job_id}: ` +
            `${String(error)} — leaving the row reclaimable and retrying next pass`,
        );
      }
    }

    let purged = 0;
    if (reclaimableInDatabase.length > 0) {
      const result = await this.db.query(
        `UPDATE job_recordings
            SET data = NULL, purged_at = NOW()
          WHERE job_id = ANY($1::uuid[])`,
        [reclaimableInDatabase],
      );
      purged += result.rowCount ?? 0;
    }
    if (reclaimedInStorage.length > 0) {
      // `object_key` is deliberately kept (see migration 047): the row records
      // where the bytes were, which is what makes a failed delete retryable and
      // an expired artifact explicable after the fact.
      const result = await this.db.query(
        `UPDATE job_recordings
            SET purged_at = NOW()
          WHERE job_id = ANY($1::uuid[])`,
        [reclaimedInStorage],
      );
      purged += result.rowCount ?? 0;
    }
    return purged;
  }
}

const recordingColumns = `
    job_id, project_id, content_type, byte_size, expires_at, purged_at, created_at,
    storage_backend, object_key
`;

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
