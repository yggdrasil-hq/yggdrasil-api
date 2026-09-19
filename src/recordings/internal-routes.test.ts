import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createRecordingsInternalRouter } from "./internal-routes.js";
import type { Job } from "../jobs/types.js";
import type { JobRecording } from "./types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const INTERNAL_TOKEN = "test-internal-api-token";

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
    status: "completed",
    lastError: null,
    createdAt: new Date("2026-09-18T10:00:00.000Z"),
    startedAt: new Date("2026-09-18T10:01:00.000Z"),
    completedAt: new Date("2026-09-18T10:05:00.000Z"),
    targetRevision: null,
    restartedFromEventId: null,
    forkFromJobId: null,
    ...overrides,
  } as Job;
}

function buildApp(
  overrides: {
    job?: Job | null;
    upsert?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const app = express();

  const upsert =
    overrides.upsert ??
    vi.fn(
      async (input: {
        jobId: string;
        projectId: string;
        contentType: string;
        data: Buffer;
        expiresAt: Date;
      }): Promise<JobRecording> => ({
        jobId: input.jobId,
        projectId: input.projectId,
        contentType: input.contentType as "video/webm",
        byteSize: input.data.byteLength,
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
    createRecordingsInternalRouter({
      jobs: jobs as never,
      recordings: { upsert } as never,
    }),
  );

  return { app, upsert, jobs };
}

function post(app: express.Express, contentType = "video/webm") {
  return request(app)
    .post(`/internal/jobs/${JOB_ID}/recording`)
    .set("Authorization", `Bearer ${INTERNAL_TOKEN}`)
    .set("Content-Type", contentType);
}

describe("POST /internal/jobs/:jobId/recording", () => {
  it("stores the bytes and anchors expiry to the job's own start", async () => {
    const { app, upsert } = buildApp();
    const res = await post(app).send(Buffer.from("webm-bytes"));

    expect(res.status).toBe(201);
    expect(res.body.stored).toBe(true);
    expect(res.body.recording.state).toBe("available");

    const input = upsert.mock.calls[0]![0] as {
      data: Buffer;
      expiresAt: Date;
      projectId: string;
    };
    expect(input.data.toString()).toBe("webm-bytes");
    expect(input.projectId).toBe(PROJECT_ID);
    // Anchored to startedAt, not to upload time: a long run must not get a
    // longer retention window than a short one, and a re-post must not extend
    // the artifact's own life.
    expect(input.expiresAt.toISOString()).toBe("2026-10-18T10:01:00.000Z");
  });

  it("falls back to createdAt when a job never started", async () => {
    const { app, upsert } = buildApp({ job: makeJob({ startedAt: null }) });
    await post(app).send(Buffer.from("x"));

    const input = upsert.mock.calls[0]![0] as { expiresAt: Date };
    expect(input.expiresAt.toISOString()).toBe("2026-10-18T10:00:00.000Z");
  });

  it("202s with a reason for an oversized recording instead of failing", async () => {
    // ADR 029 item 5: a recording must never fail a test run. A 4xx here would
    // tempt the Orchestrator into treating it as a job error.
    const { app, upsert } = buildApp();
    const res = await post(app).send(Buffer.alloc(30_000_000));

    expect(res.status).toBe(202);
    expect(res.body.stored).toBe(false);
    expect(res.body.reason).toMatch(/limit/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("202s with a reason for an empty body", async () => {
    const { app, upsert } = buildApp();
    const res = await post(app).send(Buffer.alloc(0));

    expect(res.status).toBe(202);
    expect(res.body.reason).toMatch(/empty/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("202s for a job kind that does not record", async () => {
    // script_test_run drives no browser; storing a recording for it would be a
    // misconfiguration worth surfacing rather than a silent write.
    const { app, upsert } = buildApp({
      job: makeJob({ kind: "script_test_run" }),
    });
    const res = await post(app).send(Buffer.from("x"));

    expect(res.status).toBe(202);
    expect(res.body.reason).toMatch(/does not record/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("accepts a feature_build recording, which has a browser too", async () => {
    const { app } = buildApp({ job: makeJob({ kind: "feature_build" }) });
    const res = await post(app).send(Buffer.from("x"));
    expect(res.status).toBe(201);
  });

  it("404s for an unknown job", async () => {
    const { app } = buildApp({ job: null });
    const res = await post(app).send(Buffer.from("x"));
    expect(res.status).toBe(404);
  });

  it("404s on a malformed job id", async () => {
    const { app, jobs } = buildApp();
    const res = await request(app)
      .post("/internal/jobs/not-a-uuid/recording")
      .set("Authorization", `Bearer ${INTERNAL_TOKEN}`)
      .set("Content-Type", "video/webm")
      .send(Buffer.from("x"));

    expect(res.status).toBe(404);
    expect(jobs.findById).not.toHaveBeenCalled();
  });

  it("401s without the internal token", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/recording`)
      .set("Content-Type", "video/webm")
      .send(Buffer.from("x"));

    expect(res.status).toBe(401);
  });

  it("accepts mp4 as well as webm", async () => {
    const { app, upsert } = buildApp();
    const res = await post(app, "video/mp4").send(Buffer.from("mp4-bytes"));

    expect(res.status).toBe(201);
    const input = upsert.mock.calls[0]![0] as { contentType: string };
    expect(input.contentType).toBe("video/mp4");
  });

  it("ignores a content-type parameter rather than storing it as the format", async () => {
    const { app, upsert } = buildApp();
    const res = await post(app, "video/webm; charset=binary").send(Buffer.from("x"));

    expect(res.status).toBe(201);
    const input = upsert.mock.calls[0]![0] as { contentType: string };
    expect(input.contentType).toBe("video/webm");
  });
});
