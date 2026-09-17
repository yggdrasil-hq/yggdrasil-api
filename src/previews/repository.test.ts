import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { JobPreviewRepository } from "./repository.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

interface QueryRecorder {
  pool: pg.Pool;
  query: ReturnType<typeof vi.fn>;
}

/** Records every (sql, values) pair and answers from a canned handler. */
function fakePool(
  handler: (sql: string, values: unknown[]) => { rows: unknown[] },
): QueryRecorder {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => handler(sql, values));
  return { pool: { query } as unknown as pg.Pool, query };
}

function previewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "prev_1",
    project_id: PROJECT_ID,
    job_id: JOB_ID,
    host: "acme-web-test-run-job-1.preview.yggdrasil.local",
    status: "active",
    last_error: null,
    created_at: new Date("2026-09-17T10:00:00.000Z"),
    torn_down_at: null,
    ...overrides,
  };
}

describe("JobPreviewRepository.register", () => {
  it("upserts on job_id so a retried step cannot duplicate a preview", async () => {
    const { pool, query } = fakePool(() => ({ rows: [previewRow()] }));
    const repo = new JobPreviewRepository(pool);

    const preview = await repo.register({
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      host: "acme-web-test-run-job-1.preview.yggdrasil.local",
    });

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO job_previews");
    expect(sql).toContain("ON CONFLICT (job_id) DO UPDATE");
    // Re-registering revives a row that a previous teardown had closed, which
    // is what a re-created preview needs.
    expect(sql).toContain("torn_down_at = NULL");
    expect(values).toEqual([
      PROJECT_ID,
      JOB_ID,
      "acme-web-test-run-job-1.preview.yggdrasil.local",
    ]);
    expect(preview.status).toBe("active");
    expect(preview.host).toBe("acme-web-test-run-job-1.preview.yggdrasil.local");
  });

  it("maps snake_case columns onto the camelCase shape", async () => {
    const { pool } = fakePool(() => ({
      rows: [previewRow({ torn_down_at: new Date("2026-09-17T11:00:00.000Z") })],
    }));
    const repo = new JobPreviewRepository(pool);

    const preview = await repo.register({ projectId: PROJECT_ID, jobId: JOB_ID, host: "h" });
    expect(preview.projectId).toBe(PROJECT_ID);
    expect(preview.jobId).toBe(JOB_ID);
    expect(preview.tornDownAt?.toISOString()).toBe("2026-09-17T11:00:00.000Z");
  });
});

describe("JobPreviewRepository slot accounting", () => {
  it("markFailed closes the row so a preview that never came up holds no slot", async () => {
    const { pool, query } = fakePool(() => ({ rows: [previewRow({ status: "failed" })] }));
    const repo = new JobPreviewRepository(pool);

    const preview = await repo.markFailed({
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      host: "h",
      lastError: "failed to deploy preview release: chart missing",
    });

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("INSERT INTO job_previews");
    // The failure path binds the reason, not a status: 'failed' is a literal in
    // the SQL, and torn_down_at is set to NOW() there.
    expect(sql).toContain("'failed'");
    expect(values).toEqual([
      PROJECT_ID,
      JOB_ID,
      "h",
      "failed to deploy preview release: chart missing",
    ]);
    // torn_down_at is set on the failure path, which is what keeps the row out
    // of the §17 cap: only 'active' rows are counted.
    expect(sql).toContain("NOW()");
    expect(preview.status).toBe("failed");
  });

  it("markTornDown returns null when the job never registered a preview", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    const repo = new JobPreviewRepository(pool);
    await expect(repo.markTornDown(JOB_ID)).resolves.toBeNull();
  });

  it("markTornDown is idempotent — a second call still returns the row", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [previewRow({ status: "torn_down", torn_down_at: new Date() })],
    }));
    const repo = new JobPreviewRepository(pool);

    const first = await repo.markTornDown(JOB_ID);
    const second = await repo.markTornDown(JOB_ID);
    expect(first?.status).toBe("torn_down");
    expect(second?.status).toBe("torn_down");
    // No status guard in the WHERE clause: the deferred teardown and the
    // sweep may both report the same preview and neither may error.
    expect(query.mock.calls[0][0]).not.toContain("AND status");
  });
});

describe("JobPreviewRepository.listStale", () => {
  it("collects previews by BOTH terminal-job and TTL, since neither alone is sufficient", async () => {
    const { pool, query } = fakePool(() => ({
      rows: [{ job_id: JOB_ID, project_id: PROJECT_ID, host: "h" }],
    }));
    const repo = new JobPreviewRepository(pool);

    const stale = await repo.listStale({ ttlSeconds: 7200, limit: 100 });

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("p.status = 'active'");
    // The job-side condition catches a teardown that never ran.
    expect(sql).toContain("j.status <> 'running'");
    // The TTL is the backstop for a hard-crashed job that stays 'running'
    // forever, which nothing reaps — without it that preview leaks until
    // someone intervenes.
    expect(sql).toContain("p.created_at < NOW()");
    // Inner join, deliberately: job_id is NOT NULL with ON DELETE CASCADE, so
    // a preview row cannot outlive its job and there is no dangling case to
    // handle. An outer join with an `IS NULL` branch would be dead code.
    expect(sql).toContain("JOIN jobs j ON j.id = p.job_id");
    expect(sql).not.toContain("LEFT JOIN");
    expect(sql).not.toContain("j.id IS NULL");
    expect(values).toEqual(["7200", 100]);
    expect(stale).toEqual([{ jobId: JOB_ID, projectId: PROJECT_ID, host: "h" }]);
  });

  it("orders oldest-first and bounds the batch", async () => {
    const { pool, query } = fakePool(() => ({ rows: [] }));
    const repo = new JobPreviewRepository(pool);

    await repo.listStale({ ttlSeconds: 60, limit: 5 });

    const [sql] = query.mock.calls[0];
    expect(sql).toContain("ORDER BY p.created_at ASC");
    expect(sql).toContain("LIMIT $2");
  });
});

describe("JobPreviewRepository reads", () => {
  it("listForProject is scoped to one project and newest-first", async () => {
    const { pool, query } = fakePool(() => ({ rows: [previewRow()] }));
    const repo = new JobPreviewRepository(pool);

    const previews = await repo.listForProject(PROJECT_ID);

    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain("WHERE project_id = $1");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(values).toEqual([PROJECT_ID]);
    expect(previews).toHaveLength(1);
  });

  it("findByJob looks up by job and tolerates no row", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    const repo = new JobPreviewRepository(pool);
    await expect(repo.findByJob(JOB_ID)).resolves.toBeNull();
  });
});
