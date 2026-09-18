import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { JobScreenshotRepository } from "./repository.js";

/**
 * Issue #22's storage, at the SQL-shape level.
 *
 * A fake pool cannot verify SQL — issue #43 was a repository method that raised
 * `42P08` on every call and sat behind 880 green tests — so the behavioural
 * verification for this class lives in `scripts/verify/issue-22-screenshots.mts`,
 * which runs every statement against a real PostgreSQL with all migrations
 * applied. What is asserted here is the shape a regression would silently
 * change: which columns are read, that the upsert conflicts on the step key, and
 * that the purge keeps the row.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const SCREENSHOT_ID = "33333333-3333-4333-8333-333333333333";

function fakePool(rows: unknown[]) {
  const query = vi.fn(async (_sql: string, _values: unknown[] = []) => ({ rows, rowCount: rows.length }));
  return { pool: { query } as unknown as pg.Pool, query };
}

function screenshotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SCREENSHOT_ID,
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    step_name: "Opens the cart",
    content_type: "image/png",
    byte_size: 120_000,
    expires_at: new Date("2026-10-18T10:00:00.000Z"),
    purged_at: null,
    created_at: new Date("2026-09-18T10:00:00.000Z"),
    // Issue #30: a row that predates object storage is the default a fixture
    // should carry, so the object branch is only entered when a test asks for it.
    storage_backend: "postgres",
    object_key: null,
    ...overrides,
  };
}

describe("JobScreenshotRepository.upsert", () => {
  it("conflicts on (job_id, step_name) so a retried post replaces rather than duplicates", async () => {
    const { pool, query } = fakePool([screenshotRow()]);
    const repository = new JobScreenshotRepository(pool);

    const stored = await repository.upsert({
      jobId: JOB_ID,
      projectId: PROJECT_ID,
      stepName: "Opens the cart",
      contentType: "image/png",
      data: Buffer.alloc(120_000, 1),
      expiresAt: new Date("2026-10-18T10:00:00.000Z"),
    });

    expect(stored.id).toBe(SCREENSHOT_ID);
    expect(stored.stepName).toBe("Opens the cart");

    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO job_screenshots/);
    // The key is the same one `test_run_steps` uses, which is what makes a
    // re-post idempotent instead of a duplicate artifact.
    expect(sql).toMatch(/ON CONFLICT \(job_id, step_name\) DO UPDATE/);
    // A re-upload replaces a tombstone too, which is correct if retention was
    // raised and the artifact re-collected.
    expect(sql).toMatch(/purged_at\s*=\s*NULL/);
    // `byte_size` is derived from the buffer, never taken from the caller, so a
    // caller cannot claim a size the bytes do not have.
    expect(values).toEqual([
      JOB_ID,
      PROJECT_ID,
      "Opens the cart",
      "image/png",
      120_000,
      expect.any(Buffer),
      new Date("2026-10-18T10:00:00.000Z"),
      // Issue #30: with no storage configured the bytes stay in the column, and
      // the row records that as `postgres` with no object key.
      "postgres",
      null,
    ]);
  });
});

describe("JobScreenshotRepository reads", () => {
  it("lists a job's screenshots in report order without selecting bytes", async () => {
    const { pool, query } = fakePool([screenshotRow()]);
    const repository = new JobScreenshotRepository(pool);

    const listed = await repository.listForJob(JOB_ID);

    expect(listed).toHaveLength(1);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/ORDER BY created_at ASC, step_name ASC/);
    // The listing must not pull images into memory: this is what keeps a
    // run-history response small regardless of how many screenshots a run took.
    expect(sql).not.toMatch(/\bdata\b/);
    // The storage columns *are* selected: a metadata read still needs to know
    // where the bytes live, so the UI can describe an artifact without fetching
    // it.
    expect(sql).toMatch(/storage_backend, object_key/);
    expect(values).toEqual([JOB_ID, 200]);
  });

  it("scopes the content read by job as well as id", async () => {
    // Both halves matter: the id alone would let a caller who guessed one read
    // another run's artifact, since the job is what carries the project.
    const { pool, query } = fakePool([screenshotRow()]);
    const repository = new JobScreenshotRepository(pool);

    await repository.findContent(JOB_ID, SCREENSHOT_ID);

    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/WHERE job_id = \$1 AND id = \$2/);
    expect(sql).toMatch(/, data/);
    expect(values).toEqual([JOB_ID, SCREENSHOT_ID]);
  });

  it("keeps the row when the bytes are gone, so a purge is distinguishable from an absence", async () => {
    const { pool } = fakePool([
      screenshotRow({ data: null, purged_at: new Date("2026-10-19T10:00:00.000Z") }),
    ]);
    const repository = new JobScreenshotRepository(pool);

    const found = await repository.findContent(JOB_ID, SCREENSHOT_ID);

    expect(found).not.toBeNull();
    expect(found?.data).toBeNull();
    expect(found?.purgedAt).not.toBeNull();
  });

  it("fetches object-backed bytes from the bucket", async () => {
    const { pool } = fakePool([
      screenshotRow({
        data: null,
        storage_backend: "object",
        object_key: "screenshots/p/j/s.png",
      }),
    ]);
    const asked: string[] = [];
    const storage = {
      ensureBucket: async () => undefined,
      putObject: async () => undefined,
      getObject: async (key: string) => {
        asked.push(key);
        return Buffer.from([1, 2, 3]);
      },
      deleteObject: async () => undefined,
    };

    const found = await new JobScreenshotRepository(pool, storage).findContent(
      JOB_ID,
      SCREENSHOT_ID,
    );

    expect(asked).toEqual(["screenshots/p/j/s.png"]);
    expect(found?.data).toEqual(Buffer.from([1, 2, 3]));
  });

  it("counts tombstones too, so the per-job cap cannot be reset by a purge", async () => {
    const { pool, query } = fakePool([{ count: "7" }]);
    const repository = new JobScreenshotRepository(pool);

    expect(await repository.countForJob(JOB_ID)).toBe(7);

    const [sql] = query.mock.calls[0];
    // No `data IS NOT NULL` filter, deliberately: a job that once had its full
    // quota and had it reclaimed must not silently get a fresh quota.
    expect(sql).not.toMatch(/data IS NOT NULL/);
  });
});

/**
 * Issue #30: `purgeExpired` selects its candidates first, because reclaiming an
 * object-backed artifact is a network call rather than an `UPDATE`. The fake
 * pool here answers the SELECT with a Postgres-backed candidate so the rest of
 * each assertion still describes the tombstone statement.
 */
function candidatePool(
  candidates: Array<{ id: string; storage_backend: string; object_key: string | null }>,
) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (/^\s*SELECT/i.test(sql)) return { rows: candidates, rowCount: candidates.length };
    return { rows: [], rowCount: candidates.length, values };
  });
  return { pool: { query } as unknown as pg.Pool, query };
}

describe("JobScreenshotRepository.purgeExpired", () => {
  it("nulls the bytes and stamps the purge, keeping the row", async () => {
    const { pool, query } = candidatePool([
      { id: SCREENSHOT_ID, storage_backend: "postgres", object_key: null },
    ]);
    const repository = new JobScreenshotRepository(pool);

    expect(await repository.purgeExpired()).toBe(1);

    const update = query.mock.calls.find((call) => /UPDATE/i.test(call[0] as string))!;
    expect(update[0]).toMatch(/SET data = NULL, purged_at = NOW\(\)/);
    // Targeting by id rather than by a re-run of the predicate: the candidate
    // list was already resolved, and that is what makes an object-backed row's
    // fate independent of a Postgres-backed one's.
    expect(update[0]).toMatch(/WHERE id = ANY\(\$1::uuid\[\]\)/);
  });

  it("selects only rows still holding bytes, from either backend", async () => {
    // The predicate the partial index mirrors. `object_key IS NOT NULL` is the
    // half that would be missing if this change had been made carelessly, and
    // its absence would mean object-backed artifacts were never reclaimed —
    // while every test that only used Postgres rows still passed.
    const { pool, query } = candidatePool([]);
    await new JobScreenshotRepository(pool).purgeExpired(10);

    const select = query.mock.calls[0]![0] as string;
    expect(select).toMatch(/data IS NOT NULL OR object_key IS NOT NULL/);
    expect(select).toMatch(/expires_at <= NOW\(\)/);
    expect(select).toMatch(/LIMIT \$1/);
    expect(query.mock.calls[0]![1]).toEqual([10]);
  });

  it("deletes the object and stamps the purge, keeping the object key", async () => {
    const { pool, query } = candidatePool([
      { id: SCREENSHOT_ID, storage_backend: "object", object_key: "screenshots/p/j/s.png" },
    ]);
    const deleted: string[] = [];
    const storage = {
      ensureBucket: async () => undefined,
      putObject: async () => undefined,
      getObject: async () => null,
      deleteObject: async (key: string) => {
        deleted.push(key);
      },
    };

    expect(await new JobScreenshotRepository(pool, storage).purgeExpired()).toBe(1);
    expect(deleted).toEqual(["screenshots/p/j/s.png"]);

    const update = query.mock.calls.find((call) => /UPDATE/i.test(call[0] as string))!;
    // Only the stamp: the key is deliberately kept, because it is the only record
    // of what to retry if the delete had failed, and the row already holds no
    // bytes to null.
    expect(update[0]).toMatch(/SET purged_at = NOW\(\)/);
    expect(update[0]).not.toMatch(/data = NULL/);
  });

  it("leaves an object-backed row reclaimable when the delete fails", async () => {
    // Tombstoning anyway would record "reclaimed" while the bytes stayed in the
    // bucket, and nothing would ever try again.
    const { pool, query } = candidatePool([
      { id: SCREENSHOT_ID, storage_backend: "object", object_key: "screenshots/p/j/s.png" },
    ]);
    const storage = {
      ensureBucket: async () => undefined,
      putObject: async () => undefined,
      getObject: async () => null,
      deleteObject: async () => {
        throw new Error("bucket unreachable");
      },
    };

    expect(await new JobScreenshotRepository(pool, storage).purgeExpired()).toBe(0);
    expect(query.mock.calls.some((call) => /UPDATE/i.test(call[0] as string))).toBe(false);
  });

  it("reports zero when there is nothing to reclaim", async () => {
    const { pool } = fakePool([]);
    const repository = new JobScreenshotRepository(pool);
    expect(await repository.purgeExpired()).toBe(0);
  });
});
