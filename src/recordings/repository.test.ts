import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { JobRecordingRepository } from "./repository.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "55555555-5555-4555-8555-555555555555";

interface QueryRecorder {
  pool: pg.Pool;
  query: ReturnType<typeof vi.fn>;
}

function fakePool(
  handler: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount?: number },
): QueryRecorder {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const result = handler(sql, values);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  });
  return { pool: { query } as unknown as pg.Pool, query };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    content_type: "video/webm",
    byte_size: 4_200,
    expires_at: new Date("2026-10-18T10:00:00.000Z"),
    purged_at: null,
    created_at: new Date("2026-09-18T10:00:00.000Z"),
    ...overrides,
  };
}

describe("JobRecordingRepository.upsert", () => {
  it("maps a row back into the domain shape", async () => {
    const { pool } = fakePool(() => ({ rows: [row()] }));
    const recording = await new JobRecordingRepository(pool).upsert({
      jobId: JOB_ID,
      projectId: PROJECT_ID,
      contentType: "video/webm",
      data: Buffer.from("bytes"),
      expiresAt: new Date("2026-10-18T10:00:00.000Z"),
    });

    expect(recording.jobId).toBe(JOB_ID);
    expect(recording.contentType).toBe("video/webm");
    expect(recording.byteSize).toBe(4_200);
    expect(recording.purgedAt).toBeNull();
  });

  it("derives byte_size from the buffer rather than trusting a caller", async () => {
    const { pool, query } = fakePool(() => ({ rows: [row({ byte_size: 11 })] }));
    await new JobRecordingRepository(pool).upsert({
      jobId: JOB_ID,
      projectId: PROJECT_ID,
      contentType: "video/webm",
      data: Buffer.from("eleven-byte"),
      expiresAt: new Date(),
    });

    const values = query.mock.calls[0]![1] as unknown[];
    expect(values[3]).toBe(11);
  });

  it("clears a tombstone on re-upload, so a purged artifact can come back", async () => {
    const { pool, query } = fakePool(() => ({ rows: [row()] }));
    await new JobRecordingRepository(pool).upsert({
      jobId: JOB_ID,
      projectId: PROJECT_ID,
      contentType: "video/webm",
      data: Buffer.from("x"),
      expiresAt: new Date(),
    });

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/ON CONFLICT \(job_id\)/);
    expect(sql).toMatch(/purged_at\s*=\s*NULL/);
    expect(sql).toMatch(/data\s*=\s*EXCLUDED\.data/);
  });
});

describe("JobRecordingRepository.findByJob", () => {
  it("never selects the bytes", async () => {
    // The listing path must not be able to pull video into memory by mistake.
    const { pool, query } = fakePool(() => ({ rows: [row()] }));
    await new JobRecordingRepository(pool).findByJob(JOB_ID);

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).not.toMatch(/\bdata\b/);
  });

  it("returns null when the job has no recording", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    expect(await new JobRecordingRepository(pool).findByJob(JOB_ID)).toBeNull();
  });

  it("reports a tombstone with its purge stamp", async () => {
    const purgedAt = new Date("2026-10-19T00:00:00.000Z");
    const { pool } = fakePool(() => ({
      rows: [row({ purged_at: purgedAt, data: null })],
    }));
    const recording = await new JobRecordingRepository(pool).findByJob(JOB_ID);
    expect(recording?.purgedAt).toEqual(purgedAt);
  });
});

describe("JobRecordingRepository.findContent", () => {
  it("returns the bytes and the row together", async () => {
    const { pool } = fakePool(() => ({ rows: [row({ data: Buffer.from("v") })] }));
    const content = await new JobRecordingRepository(pool).findContent(JOB_ID);
    expect(content?.data?.toString()).toBe("v");
  });

  it("returns the row with null bytes for a tombstone, rather than null", async () => {
    // The caller distinguishes "purged" (row, no bytes -> 410) from "never
    // stored" (no row -> 404) off exactly this, so the row must survive.
    const { pool } = fakePool(() => ({
      rows: [row({ data: null, purged_at: new Date() })],
    }));
    const content = await new JobRecordingRepository(pool).findContent(JOB_ID);
    expect(content).not.toBeNull();
    expect(content?.data).toBeNull();
  });

  it("returns null when there is no row at all", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    expect(await new JobRecordingRepository(pool).findContent(JOB_ID)).toBeNull();
  });
});

describe("JobRecordingRepository.purgeExpired", () => {
  it("tombstones rather than deleting, and only rows still holding bytes", async () => {
    const { pool, query } = fakePool(() => ({ rows: [], rowCount: 3 }));
    const purged = await new JobRecordingRepository(pool).purgeExpired();

    expect(purged).toBe(3);
    const sql = query.mock.calls[0]![0] as string;
    // DELETE would erase the fact that a recording existed; UPDATE keeps it.
    expect(sql).toMatch(/UPDATE job_recordings/);
    expect(sql).not.toMatch(/DELETE/i);
    expect(sql).toMatch(/SET data = NULL, purged_at = NOW\(\)/);
    expect(sql).toMatch(/data IS NOT NULL/);
  });

  it("uses the same expiry predicate as the pure state function", async () => {
    // `expires_at <= NOW()` must mirror recordingState's `expiresAt <= now`.
    // If these drift, an artifact is either a link that 404s or bytes that are
    // never reclaimed.
    const { pool, query } = fakePool(() => ({ rows: [], rowCount: 0 }));
    await new JobRecordingRepository(pool).purgeExpired();

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/expires_at <= NOW\(\)/);
  });

  it("bounds how much it reclaims per call, so a backlog drains in ticks", async () => {
    const { pool, query } = fakePool(() => ({ rows: [], rowCount: 0 }));
    await new JobRecordingRepository(pool).purgeExpired(10);

    const sql = query.mock.calls[0]![0] as string;
    expect(sql).toMatch(/LIMIT \$1/);
    expect(query.mock.calls[0]![1]).toEqual([10]);
  });

  it("reports zero when there is nothing to reclaim", async () => {
    const { pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    expect(await new JobRecordingRepository(pool).purgeExpired()).toBe(0);
  });
});
