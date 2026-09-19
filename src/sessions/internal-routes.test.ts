import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createSessionsInternalRouter } from "./internal-routes.js";
import type { Job } from "../jobs/types.js";
import type { JobSession } from "./types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const INTERNAL_TOKEN = "test-internal-api-token";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    projectId: PROJECT_ID,
    // The only kind that collects a session (ADR 032 item 1;
    // `internal/worker/specgrill.go` is the sole caller of collectSession).
    kind: "spec_grill",
    featureId: null,
    testId: null,
    testGroup: null,
    ref: null,
    trigger: null,
    designName: null,
    designSlug: null,
    designDescription: null,
    designId: null,
    specContext: null,
    status: "completed",
    lastError: null,
    createdAt: new Date("2026-09-18T10:00:00.000Z"),
    startedAt: new Date("2026-09-18T10:01:00.000Z"),
    completedAt: new Date("2026-09-18T10:05:00.000Z"),
    targetRevision: null,
    restartedFromEventId: null,
    ...overrides,
  } as Job;
}

function buildApp(overrides: { job?: Job | null; upsert?: ReturnType<typeof vi.fn> } = {}) {
  const app = express();

  const upsert =
    overrides.upsert ??
    vi.fn(
      async (input: {
        jobId: string;
        projectId: string;
        outcome: "collected" | "not_collected" | "unavailable";
        sessionId: string | null;
        podFilePath: string | null;
        data: Buffer | null;
        expiresAt: Date | null;
      }): Promise<JobSession> => ({
        jobId: input.jobId,
        projectId: input.projectId,
        outcome: input.outcome,
        sessionId: input.sessionId,
        podFilePath: input.podFilePath,
        byteSize: input.data?.byteLength ?? null,
        expiresAt: input.expiresAt,
        purgedAt: null,
        createdAt: new Date(),
      }),
    );

  const jobs = {
    findById: vi.fn(async () => (overrides.job === undefined ? makeJob() : overrides.job)),
  };

  app.use(
    "/internal",
    createSessionsInternalRouter({
      jobs: jobs as never,
      sessions: { upsert } as never,
    }),
  );

  return { app, upsert, jobs };
}

function post(
  app: express.Express,
  query: string,
  contentType = "application/x-ndjson",
) {
  return request(app)
    .post(`/internal/jobs/${JOB_ID}/session?${query}`)
    .set("Authorization", `Bearer ${INTERNAL_TOKEN}`)
    .set("Content-Type", contentType);
}

describe("POST /internal/jobs/:jobId/session", () => {
  it("stores the bytes and anchors expiry to the job's own start", async () => {
    const { app, upsert } = buildApp();
    const res = await post(app, "outcome=collected&sessionId=s-1").send(
      Buffer.from('{"type":"user","id":"e1"}\n'),
    );

    expect(res.status).toBe(201);
    expect(res.body.stored).toBe(true);
    expect(res.body.session.state).toBe("available");
    expect(res.body.session.canFork).toBe(true);

    const input = upsert.mock.calls[0]![0] as {
      data: Buffer;
      expiresAt: Date;
      sessionId: string;
      outcome: string;
      projectId: string;
    };
    expect(input.data.toString()).toBe('{"type":"user","id":"e1"}\n');
    expect(input.sessionId).toBe("s-1");
    expect(input.outcome).toBe("collected");
    expect(input.projectId).toBe(PROJECT_ID);
    // Anchored to startedAt, not to upload time — the same rule recordings use.
    expect(input.expiresAt.toISOString()).toBe("2026-10-18T10:01:00.000Z");
  });

  it("falls back to createdAt when a job never started", async () => {
    const { app, upsert } = buildApp({ job: makeJob({ startedAt: null }) });
    await post(app, "outcome=collected").send(Buffer.from("x"));

    expect((upsert.mock.calls[0]![0] as { expiresAt: Date }).expiresAt.toISOString()).toBe(
      "2026-10-18T10:00:00.000Z",
    );
  });

  /**
   * ADR 032 item 5's reason for existing: the two failing outcomes are recorded
   * with **no bytes and no expiry**, and they are recorded separately rather than
   * collapsed. Empty `expiresAt` is not an oversight — nothing was stored, so
   * there is nothing to expire, and the table's CHECK requires NULL.
   */
  it("records not_collected as a fact about the run, with no bytes and no expiry", async () => {
    const { app, upsert } = buildApp();
    const res = await post(app, "outcome=not_collected");

    expect(res.status).toBe(201);
    expect(res.body.session.state).toBe("not_collected");
    expect(res.body.session.canFork).toBe(false);

    const input = upsert.mock.calls[0]![0] as { data: Buffer | null; expiresAt: Date | null };
    expect(input.data).toBeNull();
    expect(input.expiresAt).toBeNull();
  });

  it("records unavailable distinctly, so a retrieval failure is not a fact about the run", async () => {
    const { app, upsert } = buildApp();
    const res = await post(app, "outcome=unavailable");

    expect(res.status).toBe(201);
    expect(res.body.session.state).toBe("unavailable");
    expect((upsert.mock.calls[0]![0] as { outcome: string }).outcome).toBe("unavailable");
  });

  it("carries the pod path and no session id as null rather than empty strings", async () => {
    // An empty query value must not become `""`, which would be a third state
    // meaning nothing — the column's job is to say whether Pi reported an id.
    const { app, upsert } = buildApp();
    await post(app, "outcome=collected&sessionId=&podFilePath=%2Froot%2Fs.jsonl").send(
      Buffer.from("x"),
    );

    const input = upsert.mock.calls[0]![0] as {
      sessionId: string | null;
      podFilePath: string | null;
    };
    expect(input.sessionId).toBeNull();
    expect(input.podFilePath).toBe("/root/s.jsonl");
  });

  it("202s when the outcome is missing, rather than guessing one", async () => {
    // A default here would be the bug item 5 exists to prevent: the outcome is the
    // only thing that distinguishes "no session" from "could not retrieve it".
    const { app, upsert } = buildApp();
    const res = await post(app, "");

    expect(res.status).toBe(202);
    expect(res.body.stored).toBe(false);
    expect(res.body.reason).toContain("(missing)");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("202s on an unrecognised outcome rather than coercing it", async () => {
    // `disabled` is the realistic case: it is a fact about the installation, so the
    // Orchestrator never posts it — but a future version that did must not have it
    // silently mapped onto `unavailable`.
    const { app, upsert } = buildApp();
    const res = await post(app, "outcome=disabled");

    expect(res.status).toBe(202);
    expect(res.body.reason).toBe("Unrecognised session outcome: disabled");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("202s with a reason when a collected session arrives with an empty body", async () => {
    const { app, upsert } = buildApp();
    const res = await post(app, "outcome=collected");

    expect(res.status).toBe(202);
    expect(res.body.reason).toContain("empty body");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("202s with a reason when a failing outcome carries bytes", async () => {
    const { app, upsert } = buildApp();
    const res = await post(app, "outcome=not_collected").send(Buffer.from("unexpected"));

    expect(res.status).toBe(202);
    expect(res.body.reason).toContain("not_collected");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("202s for a job kind that does not collect a session", async () => {
    const { app, upsert } = buildApp({ job: makeJob({ kind: "test_run" }) });
    const res = await post(app, "outcome=collected").send(Buffer.from("x"));

    expect(res.status).toBe(202);
    expect(res.body.reason).toBe("This job kind does not collect a session");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("404s for an unknown job and for a malformed id", async () => {
    const { app } = buildApp({ job: null });
    expect((await post(app, "outcome=collected").send(Buffer.alloc(0))).status).toBe(404);

    const { app: app2 } = buildApp();
    const res = await request(app2)
      .post("/internal/jobs/not-a-uuid/session?outcome=collected")
      .set("Authorization", `Bearer ${INTERNAL_TOKEN}`)
      .set("Content-Type", "application/x-ndjson")
      .send(Buffer.from("x"));
    expect(res.status).toBe(404);
  });

  it("rejects an unauthorised caller", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/session?outcome=collected`)
      .set("Content-Type", "application/x-ndjson")
      .send(Buffer.from("x"));
    expect(res.status).toBe(401);
  });

  /**
   * ADR 032 item 1 follows ADR 029's rule that an artifact must never fail a run, so
   * the body parser's own over-limit rejection has to become the same non-fatal 202
   * the handler uses. Without the error middleware this is a 413, and the
   * Orchestrator would log an artifact problem as a job failure.
   */
  it("202s, not 413s, when the body exceeds the parser's limit", async () => {
    const { app } = buildApp();
    const res = await post(app, "outcome=collected").send(Buffer.alloc(6_000_000, 1));

    expect(res.status).toBe(202);
    expect(res.body.stored).toBe(false);
    expect(res.body.reason).toContain("limit");
  });
});
