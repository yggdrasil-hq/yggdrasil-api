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

describe("JobScreenshotRepository.purgeExpired", () => {
  it("nulls the bytes and stamps the purge, keeping the row", async () => {
    const { pool, query } = fakePool([{ id: SCREENSHOT_ID }]);
    const repository = new JobScreenshotRepository(pool);

    expect(await repository.purgeExpired()).toBe(1);

    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/SET data = NULL, purged_at = NOW\(\)/);
    // `<=` matches `artifactState`'s predicate exactly — the same rule written
    // once in SQL for the sweep and once in TypeScript for a read. If these two
    // drifted, an artifact would be either a link that 404s or bytes that are
    // never reclaimed.
    expect(sql).toMatch(/expires_at <= NOW\(\)/);
    // Only rows still holding bytes, so the sweep is idempotent and a second
    // replica finds nothing to do.
    expect(sql).toMatch(/WHERE data IS NOT NULL/);
    expect(sql).toMatch(/LIMIT \$1/);
  });

  it("reports zero when there is nothing to reclaim", async () => {
    const { pool } = fakePool([]);
    const repository = new JobScreenshotRepository(pool);
    expect(await repository.purgeExpired()).toBe(0);
  });
});
