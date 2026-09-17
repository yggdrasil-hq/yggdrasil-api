import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createPreviewsInternalRouter } from "./internal-routes.js";
import type { Job } from "../jobs/types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const INTERNAL_TOKEN = "test-internal-api-token";
const HOST = "acme-web-test-run-job-1.preview.yggdrasil.local";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    projectId: PROJECT_ID,
    kind: "test_run",
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
    status: "running",
    lastError: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    targetRevision: null,
    ...overrides,
  };
}

function previewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "prev_1",
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    host: HOST,
    status: "active",
    lastError: null,
    createdAt: new Date("2026-09-17T10:00:00.000Z"),
    tornDownAt: null,
    ...overrides,
  };
}

function buildApp(opts: { job?: Job | null; stale?: unknown[] } = {}) {
  const app = express();
  app.use(express.json());

  const jobs = {
    findById: vi.fn(async () => (opts.job === undefined ? makeJob() : opts.job)),
  };
  const previews = {
    register: vi.fn(async () => previewRow()),
    markFailed: vi.fn(async (input: { lastError: string }) =>
      previewRow({ status: "failed", lastError: input.lastError }),
    ),
    markTornDown: vi.fn(async () => previewRow({ status: "torn_down", tornDownAt: new Date() })),
    listStale: vi.fn(async () => opts.stale ?? []),
  };

  app.use("/internal", createPreviewsInternalRouter({ previews: previews as never, jobs: jobs as never }));

  return { app, jobs, previews };
}

function post(app: express.Express, path: string, body: unknown = { host: HOST }) {
  return request(app)
    .post(`/internal${path}`)
    .set("Authorization", `Bearer ${INTERNAL_TOKEN}`)
    .send(body as object);
}

describe("POST /internal/jobs/:jobId/preview", () => {
  it("registers an active preview and returns its host", async () => {
    const { app, previews } = buildApp();

    const res = await post(app, `/jobs/${JOB_ID}/preview`, { host: HOST });

    expect(res.status).toBe(201);
    expect(previews.register).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      host: HOST,
    });
    expect(res.body.preview.host).toBe(HOST);
    expect(res.body.preview.status).toBe("active");
  });

  // Project comes from the job row, so a caller cannot register a preview
  // against a project it does not own by naming one in the body.
  it("derives the project from the job row, ignoring any projectId in the body", async () => {
    const { app, previews } = buildApp();

    await post(app, `/jobs/${JOB_ID}/preview`, {
      host: HOST,
      projectId: "99999999-9999-4999-8999-999999999999",
    });

    expect(previews.register).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT_ID }),
    );
  });

  it("records a failure instead of an active preview when an error is reported", async () => {
    const { app, previews } = buildApp();

    const res = await post(app, `/jobs/${JOB_ID}/preview`, {
      host: HOST,
      error: "failed to deploy preview release: chart has no templates",
    });

    expect(res.status).toBe(201);
    expect(previews.register).not.toHaveBeenCalled();
    expect(previews.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ lastError: "failed to deploy preview release: chart has no templates" }),
    );
    expect(res.body.preview.status).toBe("failed");
  });

  it("treats an empty error string as success rather than a failure", async () => {
    const { app, previews } = buildApp();

    await post(app, `/jobs/${JOB_ID}/preview`, { host: HOST, error: "" });

    expect(previews.register).toHaveBeenCalled();
    expect(previews.markFailed).not.toHaveBeenCalled();
  });

  it("rejects a missing or empty host", async () => {
    const { app, previews } = buildApp();

    expect((await post(app, `/jobs/${JOB_ID}/preview`, {})).status).toBe(400);
    expect((await post(app, `/jobs/${JOB_ID}/preview`, { host: "   " })).status).toBe(400);
    expect(previews.register).not.toHaveBeenCalled();
  });

  it("404s an unknown job", async () => {
    const { app } = buildApp({ job: null });
    expect((await post(app, `/jobs/${JOB_ID}/preview`)).status).toBe(404);
  });

  it("requires the internal token", async () => {
    const { app, previews } = buildApp();

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/preview`)
      .send({ host: HOST });

    expect(res.status).toBe(401);
    expect(previews.register).not.toHaveBeenCalled();
  });
});

describe("POST /internal/jobs/:jobId/preview/teardown", () => {
  it("frees the slot and reports the closed row", async () => {
    const { app, previews } = buildApp();

    const res = await post(app, `/jobs/${JOB_ID}/preview/teardown`, {});

    expect(res.status).toBe(200);
    expect(previews.markTornDown).toHaveBeenCalledWith(JOB_ID);
    expect(res.body.preview.status).toBe("torn_down");
  });

  // A job that failed before its preview ever came up has nothing to tear
  // down; reporting that as an error would make the deferred teardown noisy
  // for the most common failure mode.
  it("is not an error when no preview was ever registered", async () => {
    const { app, previews } = buildApp();
    previews.markTornDown.mockResolvedValueOnce(null as never);

    const res = await post(app, `/jobs/${JOB_ID}/preview/teardown`, {});

    expect(res.status).toBe(200);
    expect(res.body.preview).toBeNull();
  });

  it("requires the internal token", async () => {
    const { app } = buildApp();
    const res = await request(app).post(`/internal/jobs/${JOB_ID}/preview/teardown`).send({});
    expect(res.status).toBe(401);
  });
});

describe("GET /internal/previews/stale", () => {
  function get(app: express.Express, query = "") {
    return request(app)
      .get(`/internal/previews/stale${query}`)
      .set("Authorization", `Bearer ${INTERNAL_TOKEN}`);
  }

  it("uses the default 2h TTL and a bounded batch", async () => {
    const { app, previews } = buildApp();

    const res = await get(app);

    expect(res.status).toBe(200);
    expect(previews.listStale).toHaveBeenCalledWith({ ttlSeconds: 7200, limit: 100 });
  });

  it("passes through explicit bounds", async () => {
    const { app, previews } = buildApp();

    await get(app, "?ttlSeconds=300&limit=7");

    expect(previews.listStale).toHaveBeenCalledWith({ ttlSeconds: 300, limit: 7 });
  });

  // The sweep is a background caller: a malformed query must not fail the
  // whole call, because that would stall cleanup instead of bounding it.
  it("falls back and clamps rather than rejecting a malformed query", async () => {
    const { app, previews } = buildApp();

    await get(app, "?ttlSeconds=abc&limit=-5");
    expect(previews.listStale).toHaveBeenLastCalledWith({ ttlSeconds: 7200, limit: 1 });

    // Clamped to [60, 86400] and [1, 500].
    await get(app, "?ttlSeconds=1&limit=99999");
    expect(previews.listStale).toHaveBeenLastCalledWith({ ttlSeconds: 60, limit: 500 });
  });

  it("returns the work list", async () => {
    const { app } = buildApp({
      stale: [{ jobId: JOB_ID, projectId: PROJECT_ID, host: HOST }],
    });

    const res = await get(app);

    expect(res.body.previews).toEqual([{ jobId: JOB_ID, projectId: PROJECT_ID, host: HOST }]);
  });

  it("requires the internal token", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/internal/previews/stale");
    expect(res.status).toBe(401);
  });
});
