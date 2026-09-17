import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDeploysInternalRouter } from "./internal-routes.js";
import type { Job } from "../jobs/types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

const INTERNAL_TOKEN = "test-internal-api-token";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    projectId: PROJECT_ID,
    kind: "deploy",
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
    restartedFromEventId: null,
    ...overrides,
  };
}

function buildApp(opts: { job?: Job | null } = {}) {
  const app = express();
  app.use(express.json());

  const jobs = {
    findById: vi.fn(async () => (opts.job === undefined ? makeJob() : opts.job)),
  };
  const deploys = {
    record: vi.fn(async (input: Record<string, unknown>) => ({ id: "deploy_1", ...input })),
  };

  app.use(
    "/internal",
    createDeploysInternalRouter({
      deploys: deploys as never,
      jobs: jobs as never,
    }),
  );

  return { app, jobs, deploys };
}

function post(app: express.Express, jobId = JOB_ID, body: unknown = { revision: 4 }) {
  return request(app)
    .post(`/internal/jobs/${jobId}/deploy-result`)
    .set("Authorization", `Bearer ${INTERNAL_TOKEN}`)
    .send(body as object);
}

describe("POST /internal/jobs/:jobId/deploy-result", () => {
  it("records a completed deploy with the revision it produced", async () => {
    const { app, deploys } = buildApp({ job: makeJob({ kind: "deploy", ref: "main" }) });

    const res = await post(app, JOB_ID, { revision: 4 });

    expect(res.status).toBe(201);
    expect(deploys.record).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      kind: "deploy",
      helmRevision: 4,
      targetRevision: null,
      status: "completed",
      lastError: null,
      ref: "main",
    });
  });

  // The ledger row's project/kind/ref come from the job the API enqueued, not
  // from the request body, so a caller cannot attribute a deploy to another
  // project or claim a rollback was a routine deploy. Only the outcome is
  // taken from the body.
  it("derives project, kind and ref from the job row, not the request body", async () => {
    const { app, deploys } = buildApp({
      job: makeJob({ kind: "rollback", projectId: OTHER_PROJECT_ID, ref: "abc123" }),
    });

    const res = await post(app, JOB_ID, {
      revision: 10,
      targetRevision: 3,
      projectId: PROJECT_ID,
      kind: "deploy",
      ref: "spoofed",
    });

    expect(res.status).toBe(201);
    expect(deploys.record).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: OTHER_PROJECT_ID,
        kind: "rollback",
        ref: "abc123",
      }),
    );
  });

  it("records a rollback with both the produced and the requested revision", async () => {
    const { app, deploys } = buildApp({ job: makeJob({ kind: "rollback" }) });

    const res = await post(app, JOB_ID, { revision: 10, targetRevision: 3 });

    expect(res.status).toBe(201);
    expect(deploys.record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "rollback",
        helmRevision: 10,
        targetRevision: 3,
        status: "completed",
      }),
    );
  });

  // A failed attempt produced no new revision, so the row must carry NULL
  // rather than 0. Otherwise revision 0 would be a "real" number that the
  // rollback-target query would happily offer to an operator.
  it("stores a null revision for a failed attempt", async () => {
    const { app, deploys } = buildApp({ job: makeJob() });

    const res = await post(app, JOB_ID, {
      revision: 0,
      lastError: "helm upgrade failed: timed out waiting for the condition",
    });

    expect(res.status).toBe(201);
    expect(deploys.record).toHaveBeenCalledWith(
      expect.objectContaining({
        helmRevision: null,
        status: "failed",
        lastError: "helm upgrade failed: timed out waiting for the condition",
      }),
    );
  });

  // Even a caller that sends a revision alongside an error must not produce a
  // rollback-able row: the operation failed, so nothing was applied.
  it("drops the revision when an error is reported alongside it", async () => {
    const { app, deploys } = buildApp({ job: makeJob() });

    const res = await post(app, JOB_ID, { revision: 7, lastError: "helm rollback failed" });

    expect(res.status).toBe(201);
    expect(deploys.record).toHaveBeenCalledWith(
      expect.objectContaining({ helmRevision: null, status: "failed" }),
    );
  });

  it("404s for an unknown job", async () => {
    const { app, deploys } = buildApp({ job: null });

    const res = await post(app);

    expect(res.status).toBe(404);
    expect(deploys.record).not.toHaveBeenCalled();
  });

  it("rejects a job that is neither a deploy nor a rollback", async () => {
    const { app, deploys } = buildApp({ job: makeJob({ kind: "spec_grill" }) });

    const res = await post(app);

    expect(res.status).toBe(400);
    expect(deploys.record).not.toHaveBeenCalled();
  });

  it("requires the internal bearer token", async () => {
    const { app, deploys } = buildApp();

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/deploy-result`)
      .send({ revision: 1 });

    expect(res.status).toBe(401);
    expect(deploys.record).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload", async () => {
    const { app, deploys } = buildApp();

    const res = await post(app, JOB_ID, { revision: -1 });

    expect(res.status).toBe(400);
    expect(deploys.record).not.toHaveBeenCalled();
  });
});
