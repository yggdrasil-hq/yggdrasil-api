import type pg from "pg";
import type { ObjectStorage } from "../storage/client.js";
import { sessionKey } from "../storage/keys.js";
import type {
  ForkPointOutcome,
  ForkPointState,
  SessionOutcome,
} from "./retention.js";
import type { ForkPoint, JobForkPoints, JobSession, JobSessionContent } from "./types.js";

interface SessionRow {
  job_id: string;
  project_id: string;
  outcome: SessionOutcome;
  session_id: string | null;
  pod_file_path: string | null;
  byte_size: number | null;
  storage_backend: StorageBackend;
  object_key: string | null;
  expires_at: Date | null;
  purged_at: Date | null;
  created_at: Date;
}

interface SessionContentRow extends SessionRow {
  data: Buffer | null;
}

interface ForkPointRow {
  job_id: string;
  outcome: ForkPointOutcome;
  points: ForkPoint[] | null;
  captured_at: Date;
}

type StorageBackend = "postgres" | "object";

/**
 * ADR 032 item 1's storage for Pi session files, on either backend (issue #30).
 *
 * Shaped after `JobRecordingRepository` deliberately and in detail — the same two
 * byte-touching methods (`upsert`, `findContent`) as the storage seam, the same
 * "which backend is decided per row rather than per process" rule, the same
 * object-before-row ordering with a cleanup on failure, and the same split
 * `purgeExpired` into per-backend passes because reclaiming an object is a network
 * call that can fail. ADR 032's claim is that this is the third artifact type
 * through one layer, and a class that did not match the first two would be evidence
 * against that claim rather than for it.
 *
 * **The one thing it does that recordings do not** is store a row for a session
 * that was *not* collected. That is item 5, and it is why this repository's
 * `upsert` takes a nullable buffer: three of the four outcomes are "no artifact,
 * and here is which kind of no". Storing them is the point — a caller who cannot
 * tell a retrieval failure from a fact about the run is back to the bug the
 * Orchestrator's `rpc.SessionFile.Asked` exists to prevent.
 */
export class JobSessionRepository {
  constructor(
    private readonly db: pg.Pool,
    private readonly storage: ObjectStorage | null = null,
  ) {}

  /**
   * Stores (or replaces) what became of one job's session.
   *
   * Upsert rather than insert, for the reason `JobRecordingRepository.upsert`
   * gives: the Orchestrator's upload is a best-effort side channel with no
   * exactly-once guarantee, so a retried post must neither duplicate the artifact
   * nor fail the job.
   *
   * **A failing outcome replaces a collected one, and that is correct.** The
   * Orchestrator downgrades a *successful* read whose post failed to `unavailable`
   * (`sessionCollection.report`), so the last word on a job is the truthful one: if
   * the API never received the bytes then from the API's side, nothing was
   * collected. A later successful retry replaces it back, because `ON CONFLICT`
   * rewrites every column.
   *
   * `byteSize` is measured here from the buffer rather than accepted as an argument,
   * because `SessionArtifact` deliberately has no size field — the bytes *are* the
   * body, so this process's own count is the authoritative one and a caller-supplied
   * number could disagree with the payload it describes.
   */
  async upsert(input: {
    jobId: string;
    projectId: string;
    outcome: SessionOutcome;
    sessionId: string | null;
    podFilePath: string | null;
    /** Null for the three failing outcomes, which carry no artifact. */
    data: Buffer | null;
    /** Null for a failing outcome — nothing was stored, so nothing expires. */
    expiresAt: Date | null;
  }): Promise<JobSession> {
    const collecting = input.outcome === "collected" && input.data !== null;
    const backend: StorageBackend = this.storage ? "object" : "postgres";
    const key =
      collecting && this.storage
        ? sessionKey({ projectId: input.projectId, jobId: input.jobId })
        : null;

    if (collecting && this.storage && key) {
      await this.storage.putObject({
        key,
        body: input.data!,
        contentType: "application/x-ndjson",
      });
    }

    try {
      const result = await this.db.query<SessionRow>(
        `INSERT INTO job_sessions
           (job_id, project_id, outcome, session_id, pod_file_path, byte_size,
            data, object_key, storage_backend, expires_at, purged_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
         ON CONFLICT (job_id) DO UPDATE SET
           outcome         = EXCLUDED.outcome,
           session_id      = EXCLUDED.session_id,
           pod_file_path   = EXCLUDED.pod_file_path,
           byte_size       = EXCLUDED.byte_size,
           data            = EXCLUDED.data,
           object_key      = EXCLUDED.object_key,
           storage_backend = EXCLUDED.storage_backend,
           expires_at      = EXCLUDED.expires_at,
           purged_at       = NULL
         RETURNING ${sessionColumns}`,
        [
          input.jobId,
          input.projectId,
          input.outcome,
          input.sessionId,
          input.podFilePath,
          collecting ? input.data!.byteLength : null,
          // Mutually exclusive with object_key, and the table's CHECK enforces it:
          // the bytes live in exactly one place. Both are null for a failing
          // outcome, which is the fourth state the CHECK spells out.
          collecting && backend === "postgres" ? input.data : null,
          key,
          backend,
          collecting ? input.expiresAt : null,
        ],
      );
      return mapSession(result.rows[0]!);
    } catch (error) {
      if (collecting && this.storage && key) {
        // Best-effort, and the same trade-off `JobRecordingRepository.upsert`
        // documents: a row is what a reader resolves, so an orphaned object is
        // preferable to a dangling row — the inverse mistake is visible to a user.
        try {
          await this.storage.deleteObject(key);
        } catch (cleanupError) {
          console.error(
            `failed to clean up object ${key} after a failed session insert: ` +
              `${String(cleanupError)} — this object is now unreferenced`,
          );
        }
      }
      throw error;
    }
  }

  /** Metadata only — never pulls bytes, from either backend. */
  async findByJob(jobId: string): Promise<JobSession | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT ${sessionColumns}
         FROM job_sessions
        WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    return row ? mapSession(row) : null;
  }

  /**
   * The bytes, for the download path only.
   *
   * Returns the row with `data: null` in every case where there are no bytes: a
   * tombstone, a failing outcome, or a live object-backed row whose object has
   * vanished. The caller distinguishes them from the row's own `outcome` /
   * `purged_at` — which is what makes one method serve all of them — and the
   * vanished-object case is logged at error level because it means the bucket lost
   * something the database still believes it has, which is worth someone knowing
   * about and is not something a user can act on.
   *
   * That last case is a lie of omission the log line owns up to, exactly as the
   * recording equivalent does: throwing would turn a missing artifact into a 500 on
   * a page whose honest answer is "we no longer have this", and a 404 would claim the
   * run was never recorded.
   */
  async findContent(jobId: string): Promise<JobSessionContent | null> {
    const result = await this.db.query<SessionContentRow>(
      `SELECT ${sessionColumns}, data
         FROM job_sessions
        WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) return null;

    // A failing outcome has no bytes by construction, and a Postgres-backed row
    // holds them in the column. Both are answered without touching the bucket.
    if (row.outcome !== "collected" || row.storage_backend === "postgres") {
      return { ...mapSession(row), data: row.data };
    }
    if (row.object_key === null || row.purged_at !== null) {
      // Tombstoned (or, defensively, object-backed with no key) before reading;
      // there is nothing in the bucket to ask for.
      return { ...mapSession(row), data: null };
    }

    const bytes = await this.storage!.getObject(row.object_key);
    if (bytes === null) {
      console.error(
        `session for job ${jobId} is recorded as stored at ${row.object_key}, ` +
          `but that object does not exist — the artifact is unrecoverable`,
      );
    }
    return { ...mapSession(row), data: bytes };
  }

  /**
   * Reclaims the bytes of stored sessions, keeping the rows as tombstones. Returns
   * how many artifacts were reclaimed.
   *
   * `expires_at <= NOW()` mirrors `sessionState`'s predicate exactly — the same rule
   * written twice, once in SQL for the sweep and once in TypeScript for a read, and
   * they must not drift. Only rows that still hold bytes are candidates, so a
   * failing outcome (which has none) is never touched and never stamped.
   *
   * **`reclaimAll` is ADR 032 item 4's "zero means reclaim everything".** A
   * non-positive `SESSION_MAX_BYTES` is the instruction "do not keep sessions", and
   * the export path honours it by refusing every upload
   * (`rejectSessionUpload`). Reclaiming only what has aged out would leave a
   * switched-off install holding every session it ever collected, which is the
   * opposite of what the setting says — so the sweep is passed the flag and drops
   * the clock from the predicate. It is a parameter rather than a second method so
   * the candidate query and both per-backend passes stay in one place.
   *
   * The per-backend split is the recording repository's, for the reason recorded
   * there: a `postgres` row is tombstoned unconditionally (nulling a column needs
   * nothing external), while an `object` row is tombstoned **only after its object
   * is gone** — a failed delete leaves the row untouched so the next tick retries
   * it, and the partial index still considers it reclaimable. Tombstoning anyway
   * would record "reclaimed" while leaving the bytes in the bucket, and nothing
   * would ever try again.
   */
  async purgeExpired(limit = 50, reclaimAll = false): Promise<number> {
    const candidates = await this.db.query<{
      job_id: string;
      storage_backend: StorageBackend;
      object_key: string | null;
    }>(
      `SELECT job_id, storage_backend, object_key
         FROM job_sessions
        WHERE (data IS NOT NULL OR object_key IS NOT NULL)
          AND ($2::boolean OR expires_at <= NOW())
        ORDER BY expires_at ASC NULLS FIRST
        LIMIT $1`,
      [limit, reclaimAll],
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
        // storage configuration while rows still point at it. Logged rather than
        // tombstoned: the bytes are out there and this process cannot reach them,
        // which is a state a later configuration change can still clean up.
        // Tombstoning would forget them.
        console.error(
          `session for job ${row.job_id} is in object storage at ${row.object_key}, ` +
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
        `UPDATE job_sessions
            SET data = NULL, purged_at = NOW()
          WHERE job_id = ANY($1::uuid[])`,
        [reclaimableInDatabase],
      );
      purged += result.rowCount ?? 0;
    }
    if (reclaimedInStorage.length > 0) {
      // `object_key` is deliberately kept, following migration 047: the row records
      // where the bytes were, which is what makes a failed delete retryable and an
      // expired artifact explicable after the fact. The CHECK permits it for exactly
      // this state.
      const result = await this.db.query(
        `UPDATE job_sessions
            SET purged_at = NOW()
          WHERE job_id = ANY($1::uuid[])`,
        [reclaimedInStorage],
      );
      purged += result.rowCount ?? 0;
    }

    // ADR 032 item 2's fork points go with the bytes, in the same pass. Two reasons
    // rather than one: a fork point without its session file cannot be acted on
    // (there is nothing to `switch_session` to), and its `text` is a copy of the
    // conversation the retention window was applied to — so leaving it behind would
    // keep conversation text past the window that reclaimed the session it came
    // from. Both lists are covered, so a row reclaimed on either backend loses its
    // points. Deleted rather than tombstoned: nothing reads a fork point for a
    // purged session, and the session row already records that it expired.
    const purgedJobs = [...reclaimableInDatabase, ...reclaimedInStorage];
    if (purgedJobs.length > 0) {
      await this.db.query(
        `DELETE FROM job_fork_points WHERE job_id = ANY($1::uuid[])`,
        [purgedJobs],
      );
    }
    return purged;
  }

  /**
   * Records which previous user messages a run's session can be forked from (ADR
   * 032 item 2), replacing any earlier record for the same job.
   *
   * **An upsert rather than an insert**, because the capture is a second, separate
   * report about the same run: a retried post, or a run whose capture was retried
   * after a transient failure, must not fail on the primary key of a row that is
   * already correct. The Orchestrator posts it once per run, so the replacement case
   * is rare — but "rare" is not a reason for a route that can 500 on a duplicated
   * delivery, which every artifact post in this suite is designed to tolerate.
   *
   * `points` is written as one JSONB value rather than row-by-row: the list is
   * always read and written whole, and its order is Pi's own answer order, which a
   * child table would have to re-encode as a position column nothing would read.
   */
  async upsertForkPoints(
    jobId: string,
    outcome: ForkPointOutcome,
    points: ForkPoint[] | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO job_fork_points (job_id, outcome, points)
            VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (job_id) DO UPDATE
              SET outcome = EXCLUDED.outcome,
                  points = EXCLUDED.points,
                  captured_at = NOW()`,
      [jobId, outcome, points === null ? null : JSON.stringify(points)],
    );
  }

  /**
   * A run's fork points, or null when this API holds no record for it.
   *
   * Null is `unknown` and not `captured`-with-nothing: only the Orchestrator's own
   * report can say "Pi answered and there are none", so a missing row must not be
   * read as an answer. The caller maps it to the wire state (`toPublicJobSession`),
   * which is where that rule is stated once.
   *
   * The out-of-contract rows the CHECK makes unwritable are still handled rather
   * than trusted: a `captured` row whose `points` came back null (a constraint
   * relaxed by a future migration, or a row written by hand) is reported as
   * `unavailable` instead of as an empty list, because an empty list is the claim
   * "there are none" and this row does not support it. Same posture as the session
   * read path's `data !== null` check.
   */
  async findForkPoints(jobId: string): Promise<JobForkPoints | null> {
    const result = await this.db.query<ForkPointRow>(
      `SELECT job_id, outcome, points, captured_at
         FROM job_fork_points
        WHERE job_id = $1`,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) return null;

    const points = row.points ?? null;
    const state: ForkPointState =
      row.outcome === "captured" && points !== null ? "captured" : "unavailable";
    return {
      jobId: row.job_id,
      state,
      outcome: row.outcome,
      points: state === "captured" ? points : null,
      capturedAt: row.captured_at,
    };
  }
}

const sessionColumns = `
    job_id, project_id, outcome, session_id, pod_file_path, byte_size,
    storage_backend, object_key, expires_at, purged_at, created_at
`;

function mapSession(row: SessionRow): JobSession {
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    outcome: row.outcome,
    sessionId: row.session_id,
    podFilePath: row.pod_file_path,
    byteSize: row.byte_size,
    expiresAt: row.expires_at,
    purgedAt: row.purged_at,
    createdAt: row.created_at,
  };
}
