import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createJobsInternalRouter } from "./internal-routes.js";
import type { JobEvent, JobEventType } from "./events-repository.js";
import type { Job } from "./types.js";

function makeEvent(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    id: "event_1",
    jobId: "job_1",
    type: "ask_user",
    question: null,
    markdown: null,
    message: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    projectId: "project_1",
    kind: "spec_grill",
    featureId: "feature_1",
    testId: null,
    status: "running",
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    ...overrides,
  };
}

type CreateInput = {
  jobId: string;
  type: JobEventType;
  question?: string;
  markdown?: string;
  message?: string;
};

function buildApp(deps: {
  create?: (input: CreateInput) => Promise<JobEvent>;
  findById?: (jobId: string) => Promise<Job | null>;
  setAwaitingUserInput?: (featureId: string, awaiting: boolean) => Promise<null>;
  setSpecReady?: (featureId: string, adrMarkdown: string) => Promise<null>;
  updateStatus?: (featureId: string, status: string) => Promise<null>;
}) {
  const create: (input: CreateInput) => Promise<JobEvent> =
    deps.create ?? (async (input) => makeEvent({ jobId: input.jobId, type: input.type }));
  const findById = deps.findById ?? (async (jobId: string) => makeJob({ id: jobId }));
  const setAwaitingUserInput = deps.setAwaitingUserInput ?? (async () => null);
  const setSpecReady = deps.setSpecReady ?? (async () => null);
  const updateStatus = deps.updateStatus ?? (async () => null);

  const app = express();
  app.use(express.json());
  app.use(
    "/internal",
    createJobsInternalRouter({
      jobEvents: { create } as never,
      jobs: { findById } as never,
      features: { setAwaitingUserInput, setSpecReady, updateStatus } as never,
    }),
  );
  return app;
}

const JOB_ID = "2d88c75e-7ad0-458c-8da5-ce8684ce6fa6";

describe("POST /internal/jobs/:jobId/events", () => {
  it("persists an ask_user event and returns its id", async () => {
    let gotInput: unknown;
    const app = buildApp({
      create: async (input) => {
        gotInput = input;
        return makeEvent({ id: "event_42", jobId: input.jobId, type: input.type, question: input.question ?? null });
      },
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "ask_user", question: "Which auth model?" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "event_42" });
    expect(gotInput).toEqual({ jobId: JOB_ID, type: "ask_user", question: "Which auth model?" });
  });

  it("persists a submit_adr event with markdown", async () => {
    const app = buildApp({});

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_adr", markdown: "# ADR 1" });

    expect(res.status).toBe(201);
  });

  it("returns 400 for an unknown event type", async () => {
    const app = buildApp({});

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "not_a_real_type" });

    expect(res.status).toBe(400);
  });

  it("returns 404 for a malformed job id", async () => {
    const app = buildApp({});

    const res = await request(app)
      .post("/internal/jobs/not-a-uuid/events")
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "ask_user", question: "x" });

    expect(res.status).toBe(404);
  });

  it("returns 500 when persistence fails (e.g. an unknown job id)", async () => {
    const app = buildApp({
      create: async () => {
        throw new Error("foreign key violation");
      },
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "ask_user", question: "x" });

    expect(res.status).toBe(500);
  });

  it("rejects a missing bearer token", async () => {
    const app = buildApp({});

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .send({ type: "ask_user", question: "x" });

    expect(res.status).toBe(401);
  });

  it("sets awaiting_user_input on the job's feature when an ask_user event arrives", async () => {
    const setAwaitingUserInput = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42" }),
      setAwaitingUserInput,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "ask_user", question: "Which auth model?" });

    expect(res.status).toBe(201);
    expect(setAwaitingUserInput).toHaveBeenCalledWith("feature_42", true);
  });

  it("clears awaiting_user_input when a run_failed event arrives", async () => {
    const setAwaitingUserInput = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42" }),
      setAwaitingUserInput,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "run_failed", message: "attach stream ended" });

    expect(res.status).toBe(201);
    expect(setAwaitingUserInput).toHaveBeenCalledWith("feature_42", false);
  });

  it("clears awaiting_user_input when a run_cancelled event arrives", async () => {
    const setAwaitingUserInput = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42" }),
      setAwaitingUserInput,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "run_cancelled", message: "job cancelled" });

    expect(res.status).toBe(201);
    expect(setAwaitingUserInput).toHaveBeenCalledWith("feature_42", false);
  });

  it("moves the feature to failed when a run_failed event arrives", async () => {
    const updateStatus = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42" }),
      updateStatus,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "run_failed", message: "404: model not found" });

    expect(res.status).toBe(201);
    expect(updateStatus).toHaveBeenCalledWith("feature_42", "failed");
  });

  it("moves the feature to cancelled when a run_cancelled event arrives", async () => {
    const updateStatus = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42" }),
      updateStatus,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "run_cancelled", message: "job cancelled" });

    expect(res.status).toBe(201);
    expect(updateStatus).toHaveBeenCalledWith("feature_42", "cancelled");
  });

  it("does not touch status for ask_user events", async () => {
    const updateStatus = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42" }),
      updateStatus,
    });

    await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "ask_user", question: "x" });

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("does not touch awaiting_user_input for submit_adr or agent_text events", async () => {
    const setAwaitingUserInput = vi.fn(async () => null);
    const app = buildApp({ setAwaitingUserInput });

    await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_adr", markdown: "# ADR" });

    expect(setAwaitingUserInput).not.toHaveBeenCalled();
  });

  it("moves the feature to spec_ready with the submitted markdown when a submit_adr event arrives", async () => {
    const setSpecReady = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42" }),
      setSpecReady,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_adr", markdown: "# ADR 1" });

    expect(res.status).toBe(201);
    expect(setSpecReady).toHaveBeenCalledWith("feature_42", "# ADR 1");
  });

  it("skips setSpecReady for a submit_adr event on a job with no feature", async () => {
    const setSpecReady = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: null }),
      setSpecReady,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_adr", markdown: "# ADR 1" });

    expect(res.status).toBe(201);
    expect(setSpecReady).not.toHaveBeenCalled();
  });

  it("skips the awaiting_user_input sync for a job with no feature (not a spec_grill job)", async () => {
    const setAwaitingUserInput = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: null }),
      setAwaitingUserInput,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "ask_user", question: "x" });

    expect(res.status).toBe(201);
    expect(setAwaitingUserInput).not.toHaveBeenCalled();
  });

  it("still returns 201 if the awaiting_user_input sync itself fails", async () => {
    const app = buildApp({
      setAwaitingUserInput: async () => {
        throw new Error("db unavailable");
      },
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "ask_user", question: "x" });

    expect(res.status).toBe(201);
  });
});
