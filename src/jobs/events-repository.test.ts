import { describe, expect, it, vi } from "vitest";
import { JobEventRepository } from "./events-repository.js";
import { LIVE_JOB_EVENTS_CHANNEL } from "../live/relay.js";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FEATURE_ID = "33333333-3333-4333-8333-333333333333";

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    job_id: JOB_ID,
    type: "agent_text",
    question: null,
    markdown: null,
    message: "hello",
    status: null,
    pr_url: null,
    summary: null,
    verdict: null,
    questionForm: null,
    action_items: null,
    design_snapshot: null,
    created_at: new Date("2026-09-18T10:00:00.000Z"),
    ...overrides,
  };
}

function fakePool(rows: Record<string, unknown[]>) {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes("INSERT INTO job_events")) return { rows: rows.insert ?? [] };
      if (sql.includes("job_events e")) return { rows: rows.scope ?? [] };
      return { rows: [] };
    }),
  };
  return { db, queries };
}

describe("JobEventRepository.create", () => {
  it("announces the new row to the live relay on the shared channel", async () => {
    // The writer and the listener must agree on the channel name; this pins the
    // writer side against the constant the relay actually LISTENs on, so the
    // two cannot drift into a relay that is silently never woken.
    const { db, queries } = fakePool({ insert: [eventRow()] });
    const repository = new JobEventRepository(db as never);

    const event = await repository.create({ jobId: JOB_ID, type: "agent_text", message: "hello" });

    expect(event.id).toBe(EVENT_ID);
    expect(queries).toContainEqual({
      sql: `SELECT pg_notify('${LIVE_JOB_EVENTS_CHANNEL}', $1)`,
      values: [EVENT_ID],
    });
  });

  it("notifies only after the row is inserted", async () => {
    // Ordering is load-bearing and is argued in the doc comment: NOTIFY becomes
    // visible to a LISTENer when its statement's transaction commits, so a
    // notify sent first could wake a listener that cannot yet read the row.
    const { db, queries } = fakePool({ insert: [eventRow()] });
    const repository = new JobEventRepository(db as never);

    await repository.create({ jobId: JOB_ID, type: "agent_text", message: "hello" });

    const insertAt = queries.findIndex((query) => query.sql.includes("INSERT INTO job_events"));
    const notifyAt = queries.findIndex((query) => query.sql.includes("pg_notify"));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(notifyAt).toBeGreaterThan(insertAt);
  });

  it("still returns the event when the announcement fails", async () => {
    // A lost notification is a gap in a live view, not a lost event: the row is
    // durable and the Web app's poll still surfaces it. Failing the write here
    // would report an error for an event that was in fact stored.
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO job_events")) return { rows: [eventRow()] };
        throw new Error("notify failed");
      }),
    };
    const repository = new JobEventRepository(db as never);

    await expect(
      repository.create({ jobId: JOB_ID, type: "agent_text", message: "hello" }),
    ).rejects.toThrow("notify failed");
  });
});

describe("JobEventRepository.findByIdWithScope", () => {
  it("returns the event with the project and feature its job belongs to", async () => {
    const { db } = fakePool({
      scope: [eventRow({ project_id: PROJECT_ID, feature_id: FEATURE_ID })],
    });
    const repository = new JobEventRepository(db as never);

    const scope = await repository.findByIdWithScope(EVENT_ID);
    expect(scope?.projectId).toBe(PROJECT_ID);
    expect(scope?.featureId).toBe(FEATURE_ID);
    expect(scope?.event).toMatchObject({ id: EVENT_ID, jobId: JOB_ID, message: "hello" });
  });

  it("keeps a null feature id rather than dropping the row", async () => {
    // ADR 014's project-scoped design_grill has no feature; the relay decides
    // what to do with that (route it nowhere, today), so the repository must not
    // make that decision by returning null here.
    const { db } = fakePool({ scope: [eventRow({ project_id: PROJECT_ID, feature_id: null })] });
    const repository = new JobEventRepository(db as never);

    const scope = await repository.findByIdWithScope(EVENT_ID);
    expect(scope).not.toBeNull();
    expect(scope?.featureId).toBeNull();
  });

  it("returns null when the row is gone", async () => {
    const { db } = fakePool({ scope: [] });
    const repository = new JobEventRepository(db as never);
    expect(await repository.findByIdWithScope(EVENT_ID)).toBeNull();
  });
});

describe("verdict persistence and the feature's latest review (issue #59)", () => {
  it("declares and stores the verdict, so it is not silently dropped", async () => {
    const { db, queries } = fakePool({ insert: [eventRow({ type: "submit_review", verdict: "approved" })] });
    const repository = new JobEventRepository(db as never);

    const event = await repository.create({
      jobId: JOB_ID,
      type: "submit_review",
      verdict: "approved",
      summary: "Looks right.",
    });

    // The regression this guards: the caller spreads a validated payload into
    // `create`, and a spread satisfies a narrower parameter — so an undeclared
    // field compiles and is discarded. That is how the verdict was lost.
    const insert = queries.find((q) => q.sql.includes("INSERT INTO job_events"));
    expect(insert?.sql).toContain("verdict");
    expect(insert?.values).toContain("approved");
    expect(event.verdict).toBe("approved");
  });

  it("stores null for an event with no verdict", async () => {
    const { db } = fakePool({ insert: [eventRow({ type: "agent_text" })] });
    const repository = new JobEventRepository(db as never);

    await repository.create({ jobId: JOB_ID, type: "agent_text", message: "hi" });

    // Nothing to assert beyond "it did not throw on a missing optional field".
    expect(true).toBe(true);
  });

  it("reads the feature's latest review through a join on jobs", async () => {
    const { db, queries } = fakePool({
      scope: [eventRow({ type: "submit_review", verdict: "changes_requested", summary: "Fix it." })],
    });
    const repository = new JobEventRepository(db as never);

    const review = await repository.findLatestReviewByFeature(FEATURE_ID);

    expect(review?.verdict).toBe("changes_requested");
    const read = queries.find((q) => q.sql.includes("submit_review"));
    // Qualified columns: `jobs` also has `id` and `created_at`, so the shared
    // unqualified `jobEventColumns` constant here would be #61 all over again.
    expect(read?.sql).toContain("e.verdict");
    expect(read?.sql).toContain("e.created_at");
    expect(read?.sql).not.toMatch(/\bSELECT id, job_id/);
    expect(read?.values).toEqual([FEATURE_ID]);
  });

  it("returns null for a feature that has never been reviewed", async () => {
    const { db } = fakePool({ scope: [] });
    const repository = new JobEventRepository(db as never);

    expect(await repository.findLatestReviewByFeature(FEATURE_ID)).toBeNull();
  });
});
