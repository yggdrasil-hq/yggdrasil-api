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
    status: null,
    prUrl: null,
    summary: null,
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
    ref: null,
    trigger: null,
    status: "running",
    lastError: null,
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
  status?: string;
  prUrl?: string;
  summary?: string;
};

function buildApp(deps: {
  create?: (input: CreateInput) => Promise<JobEvent>;
  findById?: (jobId: string) => Promise<Job | null>;
  jobsCreate?: ReturnType<typeof vi.fn>;
  setAwaitingUserInput?: (featureId: string, awaiting: boolean) => Promise<null>;
  setSpecReady?: (featureId: string, adrMarkdown: string) => Promise<null>;
  updateStatus?: (featureId: string, status: string) => Promise<null>;
  setInReview?: (featureId: string, prUrl: string) => Promise<null>;
  setRunning?: (featureId: string) => Promise<null>;
  setTesting?: (featureId: string) => Promise<null>;
  createManyActionItems?: ReturnType<typeof vi.fn>;
  createActionItemRow?: ReturnType<typeof vi.fn>;
  clearForFeatureActionItems?: ReturnType<typeof vi.fn>;
  approveReview?: (featureId: string) => Promise<null>;
  setReturned?: (featureId: string, reason: string, comment: string) => Promise<null>;
  listEnabledTests?: ReturnType<typeof vi.fn>;
  hasActiveFeatureTestRuns?: ReturnType<typeof vi.fn>;
  listFeatureTestRuns?: ReturnType<typeof vi.fn>;
  upsertStep?: ReturnType<typeof vi.fn>;
  upsertReport?: ReturnType<typeof vi.fn>;
  findReport?: ReturnType<typeof vi.fn>;
  projectFindById?: ReturnType<typeof vi.fn>;
}) {
  const create: (input: CreateInput) => Promise<JobEvent> =
    deps.create ?? (async (input) => makeEvent({ jobId: input.jobId, type: input.type }));
  const findById = deps.findById ?? (async (jobId: string) => makeJob({ id: jobId }));
  const setAwaitingUserInput = deps.setAwaitingUserInput ?? (async () => null);
  const setSpecReady = deps.setSpecReady ?? (async () => null);
  const findFeature = async () => ({
    id: "feature_42",
    projectId: "project_1",
    slug: "feature",
    title: "Feature",
    featureType: "normal",
    status: "running",
    branchName: null,
    adrMarkdown: null,
    awaitingUserInput: false,
    adrApproved: true,
    prUrl: null,
    parentFeatureId: null,
    returnReason: null,
    returnComment: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const updateStatus = deps.updateStatus ?? (async () => null);
  const setInReview = deps.setInReview ?? (async () => null);
  const setRunning = deps.setRunning ?? (async () => null);
  const setTesting = deps.setTesting ?? (async () => null);
  const approveReview = deps.approveReview ?? (async () => null);
  const setReturned = deps.setReturned ?? (async () => null);
  const listEnabledTests = deps.listEnabledTests ?? vi.fn(async () => []);
  const hasActiveFeatureTestRuns = deps.hasActiveFeatureTestRuns ?? vi.fn(async () => false);
  const listFeatureTestRuns = deps.listFeatureTestRuns ?? vi.fn(async () => []);
  const upsertStep = deps.upsertStep ?? vi.fn(async () => undefined);
  const upsertReport = deps.upsertReport ?? vi.fn(async () => undefined);
  const findReport = deps.findReport ?? vi.fn(async () => null);
  const projectFindById =
    deps.projectFindById ?? vi.fn(async () => ({ agenticReviewEnabled: false }));
  const createManyActionItems =
    deps.createManyActionItems ?? (async () => []);
  const createActionItemRow =
    deps.createActionItemRow ?? (async (featureId: string, item: unknown) => item);
  const clearForFeatureActionItems =
    deps.clearForFeatureActionItems ?? (async () => undefined);

  const app = express();
  app.use(express.json());
  app.use(
    "/internal",
    createJobsInternalRouter({
      jobEvents: { create } as never,
      jobs: { findById, create: deps.jobsCreate ?? (async () => ({ id: "kick_grill" })), hasActiveFeatureTestRuns, listFeatureTestRuns } as never,
      features: { findById: findFeature, setAwaitingUserInput, setSpecReady, updateStatus, setInReview, setRunning, setTesting, setAgenticReview: async () => null, approveReview, setReturned } as never,
      actionItems: { createMany: createManyActionItems, create: createActionItemRow, clearForFeature: clearForFeatureActionItems } as never,
      tests: { listEnabledByProject: listEnabledTests } as never,
      testRunReports: { upsertStep, upsertReport, findByJob: findReport } as never,
      projects: { findById: projectFindById } as never,
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

  it("creates Action Items when submit_adr carries an actionItems batch (ADR 015 item 4)", async () => {
    const createMany = vi.fn(async () => []);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "spec_grill" }),
      createManyActionItems: createMany,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_adr",
        markdown: "# ADR 1",
        actionItems: [
          { type: "secret_request", description: "Need an API key", secretKey: "STRIPE_API_KEY" },
          { type: "test_request", description: "Add unit tests", draftTestMarkdown: "# Test plan" },
        ],
      });

    expect(res.status).toBe(201);
    expect(createMany).toHaveBeenCalledWith(
      "feature_42",
      expect.arrayContaining([
        expect.objectContaining({ type: "secret_request", secretKey: "STRIPE_API_KEY" }),
        expect.objectContaining({ type: "test_request", draftTestMarkdown: "# Test plan" }),
      ]),
    );
  });

  it("kicks a blocked build back to draft and dispatches a fresh spec_grill (ADR 015 item 8)", async () => {
    const updateStatus = vi.fn(async () => null);
    const clearForFeature = vi.fn(async () => undefined);
    const jobsCreate = vi.fn(async () => ({ id: "kick_grill" }));
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", projectId: "proj_1", kind: "feature_build" }),
      updateStatus,
      clearForFeatureActionItems: clearForFeature,
      jobsCreate,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "request_action_item",
        actionItems: [{ type: "secret_request", description: "Need an API key", secretKey: "FOO" }],
      });

    expect(res.status).toBe(201);
    expect(updateStatus).toHaveBeenCalledWith("feature_42", "draft");
    expect(clearForFeature).toHaveBeenCalledWith("feature_42");
    expect(jobsCreate).toHaveBeenCalledWith({ projectId: "proj_1", kind: "spec_grill", featureId: "feature_42" });
  });

  it("moves a testing feature to in_review on an approved submit_review verdict (ADR 015 item 16)", async () => {
    const approveReview = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "agentic_review" }),
      approveReview,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_review", verdict: "approved", summary: "LGTM" });

    expect(res.status).toBe(201);
    expect(approveReview).toHaveBeenCalledWith("feature_42");
  });

  it("moves a testing feature to returned (agentic_review) on a changes_requested verdict", async () => {
    const setReturned = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "agentic_review" }),
      setReturned,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_review", verdict: "changes_requested", summary: "Fix the auth flow" });

    expect(res.status).toBe(201);
    expect(setReturned).toHaveBeenCalledWith("feature_42", "agentic_review", "Fix the auth flow");
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

  it("moves the feature to testing when submit_build_result reports success (ADR 015 item 3)", async () => {
    const setTesting = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "feature_build" }),
      setTesting,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_build_result",
        status: "success",
        prUrl: "https://github.com/acme/web/pull/42",
        summary: "Added dark mode.",
      });

    expect(res.status).toBe(201);
    expect(setTesting).toHaveBeenCalledWith(
      "feature_42",
      "https://github.com/acme/web/pull/42",
    );
  });

  it("moves the feature to failed when submit_build_result reports failure", async () => {
    const updateStatus = vi.fn(async () => null);
    const setInReview = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "feature_build" }),
      updateStatus,
      setInReview,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_build_result",
        status: "failure",
        summary: "ADR referenced a package that does not exist.",
      });

    expect(res.status).toBe(201);
    expect(updateStatus).toHaveBeenCalledWith("feature_42", "failed");
    expect(setInReview).not.toHaveBeenCalled();
  });

  it("dispatches one feature-ref test run per enabled test", async () => {
    const setTesting = vi.fn(async () => ({ id: "feature_42" }));
    const jobsCreate = vi.fn(async () => ({ id: "test_job_1" }));
    const listEnabledTests = vi.fn(async () => [{ id: "test_1" }, { id: "test_2" }]);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "feature_build" }),
      setTesting: setTesting as never,
      jobsCreate,
      listEnabledTests,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_build_result", status: "success", prUrl: "https://example.test/pr/1" });

    expect(res.status).toBe(201);
    expect(jobsCreate).toHaveBeenCalledTimes(2);
    expect(jobsCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "test_run",
      testId: "test_1",
      ref: "yggdrasil/feature-feature_42",
    }));
  });

  it("persists test steps and rejects incomplete final reports", async () => {
    const upsertStep = vi.fn(async () => undefined);
    const app = buildApp({
      upsertStep,
      findById: async () => makeJob({ kind: "test_run", featureId: "feature_42" }),
    });
    const step = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "report_test_step",
        testName: "opens checkout",
        testStatus: "pass",
        testDetails: "done",
      });
    expect(step.status).toBe(201);
    expect(upsertStep).toHaveBeenCalledWith(expect.objectContaining({
      jobId: JOB_ID,
      name: "opens checkout",
      status: "pass",
    }));

    const invalid = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_test_report", passed: 1, failed: 0 });
    expect(invalid.status).toBe(400);
  });

  it("does not touch awaiting_user_input for submit_build_result events", async () => {
    const setAwaitingUserInput = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "feature_build" }),
      setAwaitingUserInput,
    });

    await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_build_result", status: "success", prUrl: "https://github.com/acme/web/pull/42" });

    expect(setAwaitingUserInput).not.toHaveBeenCalled();
  });

  it("skips setTesting for a submit_build_result event on a job with no feature", async () => {
    const setTesting = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: null, kind: "feature_build" }),
      setTesting,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_build_result", status: "success", prUrl: "https://github.com/acme/web/pull/42" });

    expect(res.status).toBe(201);
    expect(setTesting).not.toHaveBeenCalled();
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

  it("moves the feature to running when a run_started event arrives", async () => {
    const setRunning = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "feature_build" }),
      setRunning,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "run_started" });

    expect(res.status).toBe(201);
    expect(setRunning).toHaveBeenCalledWith("feature_42");
  });

  it("does not touch awaiting_user_input or updateStatus for run_started events", async () => {
    const setAwaitingUserInput = vi.fn(async () => null);
    const updateStatus = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "feature_build" }),
      setAwaitingUserInput,
      updateStatus,
    });

    await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "run_started" });

    expect(setAwaitingUserInput).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("skips setRunning for a run_started event on a job with no feature", async () => {
    const setRunning = vi.fn(async () => null);
    const app = buildApp({
      findById: async () => makeJob({ featureId: null, kind: "feature_build" }),
      setRunning,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "run_started" });

    expect(res.status).toBe(201);
    expect(setRunning).not.toHaveBeenCalled();
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
