import { describe, expect, it, vi } from "vitest";
import {
  NOOP_LIVE_PUBLISHER,
  PostgresDeltaPublisher,
  type LivePublisher,
} from "./deltas.js";
import { LIVE_JOB_EVENT_DELTAS_CHANNEL, deltaFromPayload } from "./types.js";

const FEATURE_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function fakeDb() {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  return {
    queries,
    db: {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [] };
      }),
    },
  };
}

describe("PostgresDeltaPublisher", () => {
  it("notifies the deltas channel with a self-contained payload", async () => {
    const { db, queries } = fakeDb();
    const publisher = new PostgresDeltaPublisher(db as never);

    await publisher.publishDelta({ featureId: FEATURE_ID, jobId: JOB_ID, text: "Hello " });

    expect(queries).toHaveLength(1);
    // Parameterised, not interpolated — the text is model output.
    expect(queries[0].sql).toBe("SELECT pg_notify($1, $2)");
    expect(queries[0].values?.[0]).toBe(LIVE_JOB_EVENT_DELTAS_CHANNEL);

    // The payload is the whole message: a delta is never stored, so unlike a
    // stored event there is no row to read back.
    const payload = String(queries[0].values?.[1]);
    expect(deltaFromPayload(payload)?.frame).toMatchObject({
      type: "job_event_delta",
      featureId: FEATURE_ID,
      jobId: JOB_ID,
      text: "Hello ",
    });
  });

  it("writes no row and reads nothing back", async () => {
    // The point of item 13's design: one delta must not become one job_events
    // row, and must not cost a lookup.
    const { db, queries } = fakeDb();
    await new PostgresDeltaPublisher(db as never).publishDelta({
      featureId: FEATURE_ID,
      jobId: JOB_ID,
      text: "a",
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).not.toMatch(/INSERT|SELECT .*FROM/i);
  });

  it("drops an oversize delta instead of failing the notification", async () => {
    // 8000 bytes is pg_notify's hard limit; sending more fails the statement, and
    // a failed notification here would take the delta path down for a value no
    // real stream produces.
    const { db, queries } = fakeDb();
    const onError = vi.fn();
    const publisher = new PostgresDeltaPublisher(db as never, { onError });

    await publisher.publishDelta({
      featureId: FEATURE_ID,
      jobId: JOB_ID,
      text: "x".repeat(20_000),
    });

    expect(queries).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("oversize payload"));
  });

  it("drops an empty delta rather than relaying a frame that appends nothing", async () => {
    const { db, queries } = fakeDb();
    const onError = vi.fn();
    const publisher = new PostgresDeltaPublisher(db as never, { onError });

    await publisher.publishDelta({ featureId: FEATURE_ID, jobId: JOB_ID, text: "" });

    expect(queries).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("empty field"));
  });

  it("propagates a database failure to the caller", async () => {
    // Unlike the repository's best-effort notify, the caller here is the
    // internal route, which catches and logs — so surfacing the error is what
    // lets that happen rather than a silent drop.
    const db = { query: vi.fn(async () => { throw new Error("notify failed"); }) };
    await expect(
      new PostgresDeltaPublisher(db as never).publishDelta({
        featureId: FEATURE_ID,
        jobId: JOB_ID,
        text: "a",
      }),
    ).rejects.toThrow("notify failed");
  });
});

describe("NOOP_LIVE_PUBLISHER", () => {
  it("accepts and drops deltas without throwing", async () => {
    // The relay-off path and the default in tests: a delta must be a no-op
    // rather than an error, so that turning the relay off cannot break a job.
    const publisher: LivePublisher = NOOP_LIVE_PUBLISHER;
    await expect(
      publisher.publishDelta({ featureId: FEATURE_ID, jobId: JOB_ID, text: "ignored" }),
    ).resolves.toBeUndefined();
  });
});
