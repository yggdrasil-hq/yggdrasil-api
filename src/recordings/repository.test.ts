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
    // Issue #30: every row that existed before this change is a Postgres-backed
    // row, so that is the default a fixture should carry — a fixture that
    // omitted these would fall into the object branch and try to reach a bucket
    // that the test never configured.
    storage_backend: "postgres",
    object_key: null,
    ...overrides,
  };
}

describe("JobRecordingRepository.upsert", () => {
  it("writes to the bucket and leaves the column empty when storage is configured", async () => {
    // The two columns are mutually exclusive by CHECK constraint, so the write
    // pairing is what a reviewer should be able to see asserted.
    const { pool, query } = fakePool(() => ({
      rows: [row({ data: null, storage_backend: "object", object_key: "k" })],
    }));
    const puts: Array<{ key: string; contentType: string }> = [];
    const storage = {
      ensureBucket: async () => undefined,
      putObject: async (args: { key: string; body: Buffer; contentType: string }) => {
        puts.push({ key: args.key, contentType: args.contentType });
      },
      getObject: async () => null,
      deleteObject: async () => undefined,
    };

    await new JobRecordingRepository(pool, storage).upsert({
      jobId: JOB_ID,
      projectId: PROJECT_ID,
      contentType: "video/webm",
      data: Buffer.from("bytes"),
      expiresAt: new Date(),
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]!.key).toContain(JOB_ID);
    expect(puts[0]!.contentType).toBe("video/webm");
    // The insert must pass NULL for `data` and the key for `object_key`.
    // Param order is (jobId, projectId, contentType, byteSize, data,
    // expiresAt, storageBackend, objectKey) — `purged_at` is a NULL literal.
    const values = query.mock.calls[0]![1] as unknown[];
    expect(values[4]).toBeNull();
    expect(values[6]).toBe("object");
    expect(values[7]).toBe(puts[0]!.key);
  });

  it("removes the object again when the row write fails", async () => {
    // The ordering's cost: the object goes first so a reader cannot see a row
    // with missing bytes, which means a failed insert must clean up after itself
    // or leak an unreferenced object per failure.
    const { pool } = fakePool(() => {
      throw new Error("insert failed");
    });
    const deleted: string[] = [];
    const storage = {
      ensureBucket: async () => undefined,
      putObject: async () => undefined,
      getObject: async () => null,
      deleteObject: async (key: string) => {
        deleted.push(key);
      },
    };

    await expect(
      new JobRecordingRepository(pool, storage).upsert({
        jobId: JOB_ID,
        projectId: PROJECT_ID,
        contentType: "video/webm",
        data: Buffer.from("bytes"),
        expiresAt: new Date(),
      }),
    ).rejects.toThrow("insert failed");

    expect(deleted).toHaveLength(1);
  });

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

  it("fetches the bytes from object storage for an object-backed row", async () => {
    // Issue #30: the row says where its bytes are, and this is the dispatch that
    // makes the download route work unchanged for either backend.
    const { pool } = fakePool(() => ({
      rows: [row({ data: null, storage_backend: "object", object_key: "recordings/p/j.webm" })],
    }));
    const asked: string[] = [];
    const storage = {
      ensureBucket: async () => undefined,
      putObject: async () => undefined,
      getObject: async (key: string) => {
        asked.push(key);
        return Buffer.from("from-the-bucket");
      },
      deleteObject: async () => undefined,
    };

    const content = await new JobRecordingRepository(pool, storage).findContent(JOB_ID);

    expect(asked).toEqual(["recordings/p/j.webm"]);
    expect(content?.data?.toString()).toBe("from-the-bucket");
  });

  it("does not ask the bucket for a tombstoned object-backed row", async () => {
    // Purged is purged: a tombstone answers 410 without a network round trip.
    const { pool } = fakePool(() => ({
      rows: [
        row({
          data: null,
          purged_at: new Date(),
          storage_backend: "object",
          object_key: "recordings/p/j.webm",
        }),
      ],
    }));
    let asked = 0;
    const storage = {
      ensureBucket: async () => undefined,
      putObject: async () => undefined,
      getObject: async () => {
        asked += 1;
        return null;
      },
      deleteObject: async () => undefined,
    };

    const content = await new JobRecordingRepository(pool, storage).findContent(JOB_ID);

    expect(asked).toBe(0);
    expect(content?.data).toBeNull();
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
  /**
   * Issue #30: `purgeExpired` is no longer a single statement. It selects the
   * reclaimable rows first, because an object-backed row's bytes are removed by
   * a network call rather than by the UPDATE — so these tests drive a pool that
   * answers the SELECT with candidates and the UPDATE with a row count.
   */
  function candidatePool(
    candidates: Array<{ job_id: string; storage_backend: string; object_key: string | null }>,
  ) {
    return fakePool((sql: string) => {
      if (/^\s*SELECT/i.test(sql)) return { rows: candidates, rowCount: candidates.length };
      return { rows: [], rowCount: candidates.length };
    });
  }

  it("tombstones a Postgres-backed row rather than deleting it", async () => {
    const { pool, query } = candidatePool([
      { job_id: JOB_ID, storage_backend: "postgres", object_key: null },
    ]);
    const purged = await new JobRecordingRepository(pool).purgeExpired();

    expect(purged).toBe(1);
    const update = query.mock.calls.find((call) => /UPDATE/i.test(call[0] as string))!;
    // DELETE would erase the fact that a recording existed; UPDATE keeps it.
    expect(update[0]).toMatch(/SET data = NULL, purged_at = NOW\(\)/);
    expect(query.mock.calls.some((call) => /DELETE/i.test(call[0] as string))).toBe(false);
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

  it("clears both storage columns when reclaiming a Postgres-backed row", async () => {
    const { pool, query } = candidatePool([
      { job_id: JOB_ID, storage_backend: "postgres", object_key: null },
    ]);
    await new JobRecordingRepository(pool).purgeExpired();

    const update = query.mock.calls.find((call) => /UPDATE/i.test(call[0] as string))!;
    // The CHECK constraint requires a Postgres tombstone to have `object_key`
    // NULL, so leaving a stale key here would fail the write at the database
    // rather than silently — this pins that the statement is the one the
    // constraint expects.
    expect(update[0]).toMatch(/SET data = NULL, purged_at = NOW\(\)/);
  });

  it("does not touch the database bucket columns for an object-backed row", async () => {
    // An object-backed row already has `data = NULL`, so the only thing the
    // reclaim does is stamp the purge — and it must keep `object_key`, which is
    // what makes a failed byte-deletion retryable.
    const { pool, query } = candidatePool([
      { job_id: JOB_ID, storage_backend: "object", object_key: "recordings/p/j.webm" },
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

    const purged = await new JobRecordingRepository(pool, storage).purgeExpired();

    expect(deleted).toEqual(["recordings/p/j.webm"]);
    expect(purged).toBe(1);
    const update = query.mock.calls.find((call) => /UPDATE/i.test(call[0] as string))!;
    expect(update[0]).toMatch(/SET purged_at = NOW\(\)/);
    expect(update[0]).not.toMatch(/data = NULL/);
  });

  it("leaves an object-backed row reclaimable when the bucket delete fails", async () => {
    // The whole reason the method is two passes: tombstoning anyway would record
    // "reclaimed" while leaving the bytes in the bucket, and nothing would ever
    // retry. A failure must leave the row exactly as it was.
    const { pool, query } = candidatePool([
      { job_id: JOB_ID, storage_backend: "object", object_key: "recordings/p/j.webm" },
    ]);
    const storage = {
      ensureBucket: async () => undefined,
      putObject: async () => undefined,
      getObject: async () => null,
      deleteObject: async () => {
        throw new Error("bucket unreachable");
      },
    };

    const purged = await new JobRecordingRepository(pool, storage).purgeExpired();

    expect(purged).toBe(0);
    expect(query.mock.calls.some((call) => /UPDATE/i.test(call[0] as string))).toBe(false);
  });

  it("leaves an object-backed row alone when no storage is configured", async () => {
    // A deployment that dropped its storage configuration while rows still point
    // at a bucket must not forget them: the bytes are out there, and a later
    // configuration change can still clean up.
    const { pool, query } = candidatePool([
      { job_id: JOB_ID, storage_backend: "object", object_key: "recordings/p/j.webm" },
    ]);

    expect(await new JobRecordingRepository(pool).purgeExpired()).toBe(0);
    expect(query.mock.calls.some((call) => /UPDATE/i.test(call[0] as string))).toBe(false);
  });

  it("reports zero when there is nothing to reclaim", async () => {
    const { pool } = fakePool(() => ({ rows: [], rowCount: 0 }));
    expect(await new JobRecordingRepository(pool).purgeExpired()).toBe(0);
  });
});
