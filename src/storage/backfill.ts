import type pg from "pg";
import type { ObjectStorage } from "./client.js";
import { extensionFileKey, recordingKey, screenshotKey } from "./keys.js";
import { stepKeySegment } from "../screenshots/repository.js";

/**
 * Issue #30: moving artifacts that were written before object storage existed.
 *
 * **Why this is a script rather than part of the migration.** Migration 047 adds
 * the columns and marks every existing row `postgres`, which leaves both
 * backends valid at once and moves nothing. That is deliberate, and the migration
 * explains why at length; the short version is that a migration which copies
 * every artifact needs the bucket reachable at boot (so a fresh install with
 * object storage not yet up would fail to migrate its own empty database), makes
 * the schema change depend on a network service, and holds a transaction open
 * for as long as it takes to stream every recording out. Doing it here means an
 * operator retires "the database backup contains video" at a time of their
 * choosing, and can stop and resume.
 *
 * **It is idempotent and resumable, which is what makes that safe.** Each row is
 * moved and then flipped in one statement, so a run that is interrupted leaves
 * the rows it finished in the object backend and the rest untouched; the next run
 * picks up exactly where it left off, because the candidate query is "rows still
 * marked postgres". There is no cursor to keep and no state outside the database.
 *
 * **Nothing is deleted from the database until the object is confirmed written
 * and a reader can still see the row.** The object goes up first; only then does
 * the single `UPDATE` swap the payload for the key. So an interruption at any
 * point leaves a row that is either fully Postgres-backed or fully
 * object-backed, and the CHECK constraint from migration 047 makes the in-between
 * state unwritable rather than merely unlikely.
 *
 * A row is skipped rather than failed when it cannot be moved — one bad artifact
 * must not stop the other few thousand — and the reason is collected so it can be
 * reported rather than swallowed.
 */

export interface BackfillResult {
  /** Rows whose bytes now live in object storage. */
  moved: number;
  /** Rows a later run should try again (a failed put). */
  failed: number;
  /** Rows already in object storage, i.e. nothing to do. */
  alreadyMoved: number;
}

export interface BackfillDeps {
  db: pg.Pool;
  storage: ObjectStorage;
  /** Bounds one call, so a large install can be drained in steps. */
  limit?: number;
  /** Called per artifact moved, for a progress line. */
  onProgress?: (message: string) => void;
}

const DEFAULT_LIMIT = 200;

/**
 * Moves recordings, screenshots and extension files.
 *
 * Ordering within the function is by table rather than by age across tables,
 * because the three are independent and a partial run that finished recordings
 * entirely is easier to describe than one that moved a third of each.
 */
export async function backfillObjects(deps: BackfillDeps): Promise<BackfillResult> {
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const total: BackfillResult = { moved: 0, failed: 0, alreadyMoved: 0 };

  for (const step of [backfillRecordings, backfillScreenshots, backfillExtensionFiles]) {
    const result = await step(deps, limit);
    total.moved += result.moved;
    total.failed += result.failed;
    total.alreadyMoved += result.alreadyMoved;
  }

  return total;
}

async function backfillRecordings(
  deps: BackfillDeps,
  limit: number,
): Promise<BackfillResult> {
  const candidates = await deps.db.query<{
    job_id: string;
    project_id: string;
    content_type: string;
    data: Buffer;
  }>(
    `SELECT job_id, project_id, content_type, data
       FROM job_recordings
      WHERE storage_backend = 'postgres' AND data IS NOT NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  const result: BackfillResult = { moved: 0, failed: 0, alreadyMoved: 0 };
  for (const row of candidates.rows) {
    const key = recordingKey({
      projectId: row.project_id,
      jobId: row.job_id,
      contentType: row.content_type,
    });
    try {
      await deps.storage.putObject({ key, body: row.data, contentType: row.content_type });
    } catch (error) {
      result.failed += 1;
      deps.onProgress?.(`recording ${row.job_id}: put failed: ${String(error)}`);
      continue;
    }

    // One statement, so `data` and `object_key` cannot disagree: the CHECK
    // constraint requires exactly one of them.
    await deps.db.query(
      `UPDATE job_recordings
          SET data = NULL, object_key = $2, storage_backend = 'object'
        WHERE job_id = $1 AND storage_backend = 'postgres'`,
      [row.job_id, key],
    );
    result.moved += 1;
    deps.onProgress?.(`recording ${row.job_id} -> ${key}`);
  }
  return result;
}

async function backfillScreenshots(
  deps: BackfillDeps,
  limit: number,
): Promise<BackfillResult> {
  const candidates = await deps.db.query<{
    id: string;
    job_id: string;
    project_id: string;
    step_name: string;
    content_type: string;
    data: Buffer;
  }>(
    `SELECT id, job_id, project_id, step_name, content_type, data
       FROM job_screenshots
      WHERE storage_backend = 'postgres' AND data IS NOT NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  const result: BackfillResult = { moved: 0, failed: 0, alreadyMoved: 0 };
  for (const row of candidates.rows) {
    /*
     * The key must match what `JobScreenshotRepository.upsert` would compute, or
     * a re-upload of the same step would write to a different object and leave
     * this one orphaned. That is why the key builders live in `keys.ts` and are
     * imported here rather than reimplemented: this is the second consumer, and
     * the second consumer is exactly where a duplicated derivation drifts.
     */
    const key = screenshotKey({
      projectId: row.project_id,
      jobId: row.job_id,
      screenshotId: stepKeySegment(row.step_name),
      contentType: row.content_type,
    });
    try {
      await deps.storage.putObject({ key, body: row.data, contentType: row.content_type });
    } catch (error) {
      result.failed += 1;
      deps.onProgress?.(`screenshot ${row.id}: put failed: ${String(error)}`);
      continue;
    }

    await deps.db.query(
      `UPDATE job_screenshots
          SET data = NULL, object_key = $2, storage_backend = 'object'
        WHERE id = $1 AND storage_backend = 'postgres'`,
      [row.id, key],
    );
    result.moved += 1;
    deps.onProgress?.(`screenshot ${row.id} -> ${key}`);
  }
  return result;
}

async function backfillExtensionFiles(
  deps: BackfillDeps,
  limit: number,
): Promise<BackfillResult> {
  const candidates = await deps.db.query<{
    extension_id: string;
    organization_id: string;
    path: string;
    content: string;
  }>(
    `SELECT f.extension_id, e.organization_id, f.path, f.content
       FROM org_extension_files f
       JOIN org_extensions e ON e.id = f.extension_id
      WHERE f.storage_backend = 'postgres' AND f.content IS NOT NULL
      ORDER BY f.extension_id, f.path
      LIMIT $1`,
    [limit],
  );

  const result: BackfillResult = { moved: 0, failed: 0, alreadyMoved: 0 };
  for (const row of candidates.rows) {
    const key = extensionFileKey({
      organizationId: row.organization_id,
      extensionId: row.extension_id,
      path: row.path,
    });
    try {
      await deps.storage.putObject({
        key,
        // The column is TEXT, so the object is its UTF-8 encoding — the same
        // conversion `createOrReplace` makes, which is what keeps a file's bytes
        // identical whichever side of the move it is read from.
        body: Buffer.from(row.content, "utf8"),
        contentType: "text/plain; charset=utf-8",
      });
    } catch (error) {
      result.failed += 1;
      deps.onProgress?.(`extension file ${row.path}: put failed: ${String(error)}`);
      continue;
    }

    await deps.db.query(
      `UPDATE org_extension_files
          SET content = NULL, object_key = $3, storage_backend = 'object'
        WHERE extension_id = $1 AND path = $2 AND storage_backend = 'postgres'`,
      [row.extension_id, row.path, key],
    );
    result.moved += 1;
  }
  return result;
}
