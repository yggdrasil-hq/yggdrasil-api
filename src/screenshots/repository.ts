import type pg from "pg";
import type { ScreenshotContentType } from "./retention.js";
import type { JobScreenshot, JobScreenshotContent } from "./types.js";

interface ScreenshotRow {
  id: string;
  job_id: string;
  project_id: string;
  step_name: string;
  content_type: ScreenshotContentType;
  byte_size: number;
  expires_at: Date;
  purged_at: Date | null;
  created_at: Date;
}

interface ScreenshotContentRow extends ScreenshotRow {
  data: Buffer | null;
}

/**
 * The columns a metadata read returns. Spelled once so the list and the
 * content read cannot drift — adding a column to one and forgetting the other
 * would surface as a missing field at runtime, not as a type error.
 */
const metadataColumns = `
  id, job_id, project_id, step_name, content_type, byte_size,
  expires_at, purged_at, created_at
`;

function mapScreenshot(row: ScreenshotRow): JobScreenshot {
  return {
    id: row.id,
    jobId: row.job_id,
    projectId: row.project_id,
    stepName: row.step_name,
    contentType: row.content_type,
    byteSize: row.byte_size,
    expiresAt: row.expires_at,
    purgedAt: row.purged_at,
    createdAt: row.created_at,
  };
}

/**
 * Issue #22's storage for per-step test-run screenshots.
 *
 * Mirrors `JobRecordingRepository` deliberately — same tombstone discipline,
 * same "bytes in Postgres for now" posture, same read paths that never touch
 * `data` unless the caller asked for bytes. The differences are the ones the
 * migration documents: keyed by `id` (a step name is free text, not a URL
 * segment), upserted on `(job_id, step_name)` (one screenshot per step), and
 * bounded per *job* as well as per file.
 *
 * The object-storage question from issue #30 arrives here at exactly the same
 * two methods (`upsert`'s payload and `findContent`) as it does for recordings,
 * because both classes were built with that swap in mind.
 */
export class JobScreenshotRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Stores (or replaces) one step's screenshot.
   *
   * Upsert on `(job_id, step_name)` rather than insert: the Orchestrator's
   * upload is a best-effort side-channel with no exactly-once guarantee — the
   * same posture `JobRecordingRepository.upsert` takes, and ADR 023's usage
   * report before it — so a retried post must replace rather than duplicate the
   * artifact. `purged_at = NULL` on conflict means a re-upload also replaces a
   * tombstone, which is correct if retention was raised and the artifact
   * re-collected.
   *
   * `project_id` is taken from the job row by the caller rather than trusted
   * from the request, matching the deploy ledger's rule: a caller cannot
   * attribute an artifact to a project it does not belong to.
   */
  async upsert(input: {
    jobId: string;
    projectId: string;
    stepName: string;
    contentType: ScreenshotContentType;
    data: Buffer;
    expiresAt: Date;
  }): Promise<JobScreenshot> {
    const result = await this.db.query<ScreenshotRow>(
      `INSERT INTO job_screenshots
         (job_id, project_id, step_name, content_type, byte_size, data, expires_at, purged_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
       ON CONFLICT (job_id, step_name) DO UPDATE SET
         content_type = EXCLUDED.content_type,
         byte_size    = EXCLUDED.byte_size,
         data         = EXCLUDED.data,
         expires_at   = EXCLUDED.expires_at,
         purged_at    = NULL
       RETURNING ${metadataColumns}`,
      [
        input.jobId,
        input.projectId,
        input.stepName,
        input.contentType,
        input.data.byteLength,
        input.data,
        input.expiresAt,
      ],
    );
    return mapScreenshot(result.rows[0]);
  }

  /**
   * One run's screenshots, oldest first — report order, so a caller can line
   * them up with the steps they annotate without re-sorting.
   *
   * Metadata only; never pulls bytes. Tombstoned rows are included on purpose:
   * a purged screenshot must still be *listed*, so the UI can say it existed and
   * was reclaimed rather than showing nothing where a step had one.
   */
  async listForJob(jobId: string, limit = 200): Promise<JobScreenshot[]> {
    const result = await this.db.query<ScreenshotRow>(
      `SELECT ${metadataColumns}
         FROM job_screenshots
        WHERE job_id = $1
        ORDER BY created_at ASC, step_name ASC
        LIMIT $2`,
      [jobId, limit],
    );
    return result.rows.map(mapScreenshot);
  }

  /** A single screenshot's metadata, used to authorize a content read. */
  async findByIdForJob(jobId: string, screenshotId: string): Promise<JobScreenshot | null> {
    const result = await this.db.query<ScreenshotRow>(
      `SELECT ${metadataColumns}
         FROM job_screenshots
        WHERE job_id = $1 AND id = $2`,
      [jobId, screenshotId],
    );
    const row = result.rows[0];
    return row ? mapScreenshot(row) : null;
  }

  /**
   * The bytes, for the download path only. Returns the row even when `data` is
   * null, so the caller can distinguish a purged artifact (row present, no
   * bytes) from an absent one (no row) and answer 410 rather than 404.
   */
  async findContent(
    jobId: string,
    screenshotId: string,
  ): Promise<JobScreenshotContent | null> {
    const result = await this.db.query<ScreenshotContentRow>(
      `SELECT ${metadataColumns}, data
         FROM job_screenshots
        WHERE job_id = $1 AND id = $2`,
      [jobId, screenshotId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...mapScreenshot(row), data: row.data };
  }

  /**
   * How many screenshots a job already has, tombstones included.
   *
   * The upsert's `ON CONFLICT` replaces rather than adds, so this counts
   * *distinct steps* — which is the quantity the per-job cap is about. Counting
   * tombstones keeps the cap monotone: a job that once had 50 screenshots and
   * had them purged does not silently get 50 more.
   */
  async countForJob(jobId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM job_screenshots WHERE job_id = $1`,
      [jobId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Reclaims the bytes of every screenshot past its expiry, keeping the rows as
   * tombstones. Returns how many artifacts were purged.
   *
   * `expires_at <= NOW()` mirrors the shared `artifactState` predicate exactly —
   * the same rule written twice, once in SQL for the sweep and once in
   * TypeScript for a read, which is precisely why that rule lives in one shared
   * module. This is the SQL half; `shared/artifacts.ts` is the other.
   *
   * `LIMIT`ed and idempotent: the partial index only covers rows still holding
   * bytes, so a second pass finds nothing, and a backlog drains over successive
   * ticks rather than in one long transaction.
   */
  async purgeExpired(limit = 100): Promise<number> {
    const result = await this.db.query(
      `UPDATE job_screenshots
          SET data = NULL, purged_at = NOW()
        WHERE id IN (
          SELECT id
            FROM job_screenshots
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
