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
    verdict: null,
    actionItems: null,
    snapshot: null,
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
    testGroup: null,
    ref: null,
    trigger: null,
    status: "running",
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    designId: null,
    designName: null,
    designSlug: null,
    designDescription: null,
    specContext: null,
    targetRevision: null,
    restartedFromEventId: null,
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
  actionItems?: Array<{
    type: string;
    description: string;
    secretKey?: string;
    draftTestMarkdown?: string;
  }>;
  snapshot?: Record<string, string>;
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
  resolveDesignSession?: ReturnType<typeof vi.fn>;
  approveReview?: (featureId: string) => Promise<null>;
  setReturned?: (featureId: string, reason: string, comment: string) => Promise<null>;
  listEnabledTests?: ReturnType<typeof vi.fn>;
  /** Issue #63: kinds the installation reports it cannot run. */
  unrunnableKinds?: string[];
  hasActiveFeatureTestRuns?: ReturnType<typeof vi.fn>;
  listFeatureTestRuns?: ReturnType<typeof vi.fn>;
  upsertStep?: ReturnType<typeof vi.fn>;
  upsertReport?: ReturnType<typeof vi.fn>;
  findReport?: ReturnType<typeof vi.fn>;
  /** Issue #40: the gate reads the feature's whole run list, not just one report. */
  listReportExecutions?: ReturnType<typeof vi.fn>;
  /** Issue #40: the gate only applies while the feature is in `testing`. */
  featureStatus?: string;
  projectFindById?: ReturnType<typeof vi.fn>;
  finalizeDesign?: ReturnType<typeof vi.fn>;
  upsertUsage?: ReturnType<typeof vi.fn>;
  /** ADR 019 item 13: the streaming-delta publisher. */
  publishDelta?: ReturnType<typeof vi.fn>;
  /** Issue #24: a fixed running total for the per-job delta byte counter. */
  deltaBytes?: number;
  /** Issue #24: how many bytes each recorded delta adds, for ceiling tests. */
  deltaBytesPerCall?: number;
  /** Issue #24: replace the byte counter outright. */
  recordRelayedDeltaBytes?: ReturnType<typeof vi.fn>;
  /**
   * Issue #24: the per-job delta ceiling this router enforces. Passed through to
   * the router so the boundary can be driven from a test without a config
   * override.
   */
  deltaBytesPerJob?: number;
  /** The catalog default for a job kind, which is how usage attribution finds a provider. */
  jobDefaultModelId?: string | null;
  catalogModel?: { providerName?: string } | null;
}) {
  const create: (input: CreateInput) => Promise<JobEvent> =
    deps.create ?? (async (input) => makeEvent({ jobId: input.jobId, type: input.type }));
  const findById = deps.findById ?? (async (jobId: string) => makeJob({ id: jobId }));
  /**
   * Issue #24: the delta ingest now advances a per-job byte counter in the same
   * statement that resolved the feature (`recordRelayedDeltaBytes`), replacing
   * the `findById` it used to do. The fake mirrors that by resolving through the
   * same `findById` these tests already stub, so a test that changes which job —
   * and therefore which feature — a delta belongs to needs no second stub.
   *
   * The returned total is what lets a test drive the ceiling; `deps.deltaBytes`
   * sets the running total and `deps.deltaBytesPerCall` how much each call adds.
   */
  const recordRelayedDeltaBytes =
    deps.recordRelayedDeltaBytes ??
    (async (jobId: string, bytes: number) => {
      const job = await findById(jobId);
      if (!job) return null;
      const previousBytes = deps.deltaBytes ?? 0;
      return {
        featureId: job.featureId,
        previousBytes,
        totalBytes: previousBytes + (deps.deltaBytesPerCall ?? bytes),
      };
    });
  const setAwaitingUserInput = deps.setAwaitingUserInput ?? (async () => null);
  const setSpecReady = deps.setSpecReady ?? (async () => null);
  const findFeature = async () => ({
    id: "feature_42",
    projectId: "project_1",
    slug: "feature",
    title: "Feature",
    featureType: "normal",
    status: deps.featureStatus ?? "running",
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
  const upsertUsage =
    deps.upsertUsage ?? vi.fn(async (input: { jobId: string }) => ({ jobId: input.jobId }));
  const publishDelta = deps.publishDelta ?? vi.fn(async () => undefined);
  // resolveModelConfigSource walks the precedence ladder narrowest-first, so a
  // fake that resolves at the org-default tier is the simplest way to drive
  // usage attribution to a provider without a real catalog.
  const modelConfig = {
    secrets: { decryptAllForProject: async () => ({}) },
    featureSecrets: { decryptAllForFeature: async () => ({}) },
    providers: {},
    models: {
      findById: async () =>
        deps.catalogModel === undefined ? null : deps.catalogModel,
    },
    jobDefaults: {
      findForJobKind: async () =>
        deps.jobDefaultModelId ? { modelId: deps.jobDefaultModelId } : null,
    },
    projectOverrides: { findForJobKind: async () => null },
    featureOverrides: { findForJobKind: async () => null },
  } as never;
  const projectFindById =
    deps.projectFindById ??
    vi.fn(async () => ({ agenticReviewEnabled: false, organizationId: ORG_ID }));
  const createManyActionItems =
    deps.createManyActionItems ?? (async () => []);
  const createActionItemRow =
    deps.createActionItemRow ?? (async (featureId: string, item: unknown) => item);
  const clearForFeatureActionItems =
    deps.clearForFeatureActionItems ?? (async () => undefined);
  const resolveDesignSession =
    deps.resolveDesignSession ?? (async () => undefined);

  const app = express();
  app.use(express.json());
  app.use(
    "/internal",
    createJobsInternalRouter({
      jobEvents: { create } as never,
      jobs: { findById, recordRelayedDeltaBytes, create: deps.jobsCreate ?? (async () => ({ id: "kick_grill" })), hasActiveFeatureTestRuns, listFeatureTestRuns } as never,
      features: { findById: findFeature, setAwaitingUserInput, setSpecReady, updateStatus, setInReview, setRunning, setTesting, setAgenticReview: async () => null, approveReview, setReturned } as never,
      actionItems: {
        createMany: createManyActionItems,
        create: createActionItemRow,
        clearForFeature: clearForFeatureActionItems,
        resolveDesignSession,
      } as never,
      tests: { listEnabledByProject: listEnabledTests } as never,
      testRunReports: {
        upsertStep,
        upsertReport,
        findByJob: findReport,
        listByFeature: deps.listReportExecutions ?? vi.fn(async () => []),
      } as never,
      projects: { findById: projectFindById } as never,
      capabilities: {
        unrunnable: vi.fn(async () => new Set<string>(deps.unrunnableKinds ?? [])),
      } as never,
      designs: {
        finalize: deps.finalizeDesign ?? vi.fn(async () => undefined),
      } as never,
      usage: { upsert: upsertUsage } as never,
      live: { publishDelta } as never,
      deltaBytesPerJob: deps.deltaBytesPerJob,
      modelConfig,
    }),
  );
  return app;
}

const JOB_ID = "2d88c75e-7ad0-458c-8da5-ce8684ce6fa6";
const ORG_ID = "11111111-1111-4111-8111-111111111111";

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

  it("stores kickback context on the fresh spec_grill job", async () => {
    const jobsCreate = vi.fn(async () => ({ id: "kick_grill" }));
    const listSpecGrillByFeature = vi.fn(async () => [
      makeEvent({ type: "agent_text", message: "User chose OAuth." }),
      makeEvent({ type: "user_message", message: "Use OAuth." }),
    ]);
    const listResolvedDesignSnapshots = vi.fn(async () => [
      {
        sessionId: "design-1",
        snapshot: { "designs/auth/page.html": "<h1>Sign in</h1>" },
      },
    ]);
    // The default test harness intentionally keeps dependencies small. This
    // integration-shaped assertion uses a second router with the two
    // context-producing repository methods supplied.
    const contextApp = express();
    contextApp.use(express.json());
    contextApp.use(
      "/internal",
      createJobsInternalRouter({
        jobEvents: {
          create: async (input: CreateInput) => makeEvent({ jobId: input.jobId, type: input.type }),
          listSpecGrillByFeature,
        } as never,
        jobs: {
          findById: async () => makeJob({ featureId: "feature_42", projectId: "proj_1", kind: "feature_build" }),
          recordRelayedDeltaBytes: async () => ({
            featureId: "feature_42",
            previousBytes: 0,
            totalBytes: 1,
          }),
          create: jobsCreate,
        } as never,
        features: {
          findById: async () => ({
            ...makeEvent(),
            id: "feature_42",
            projectId: "proj_1",
            adrMarkdown: "# Previous ADR",
          }),
          updateStatus: vi.fn(async () => null),
        } as never,
        actionItems: {
          clearForFeature: vi.fn(async () => undefined),
          listResolvedDesignSnapshots,
        } as never,
        tests: { listEnabledByProject: vi.fn(async () => []) } as never,
        testRunReports: {} as never,
        projects: {} as never,
        designs: {} as never,
        usage: {} as never,
        modelConfig: {} as never,
      }),
    );

    const res = await request(contextApp)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "request_action_item",
        actionItems: [{ type: "design_grill", description: "Design sign-in" }],
      });

    expect(res.status).toBe(201);
    expect(jobsCreate).toHaveBeenCalledWith(expect.objectContaining({
      specContext: expect.objectContaining({
        previousAdrMarkdown: "# Previous ADR",
        kickbackReason: "design_grill: Design sign-in",
        requestedActionItems: [{ type: "design_grill", description: "Design sign-in" }],
      }),
    }));
  });

  it("persists a full design snapshot event without treating it as a feature event", async () => {
    let gotInput: CreateInput | undefined;
    const app = buildApp({
      findById: async () => makeJob({
        featureId: null,
        kind: "design_grill",
      }),
      create: async (input) => {
        gotInput = input;
        return makeEvent({ jobId: input.jobId, type: input.type });
      },
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "update_design_preview",
        snapshot: { "designs/checkout/page.html": "<h1>Hello</h1>" },
      });

    expect(res.status).toBe(201);
    expect(gotInput).toEqual({
      jobId: JOB_ID,
      type: "update_design_preview",
      snapshot: { "designs/checkout/page.html": "<h1>Hello</h1>" },
    });
  });

  it("requires a snapshot for design events", async () => {
    const res = await request(buildApp({}))
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_design", summary: "done" });
    expect(res.status).toBe(400);
  });

  it("rejects snapshot paths outside the session design folder", async () => {
    const res = await request(buildApp({
      findById: async () => makeJob({ featureId: null, kind: "design_grill", designSlug: "checkout" }),
    }))
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "update_design_preview",
        snapshot: { "designs/other/page.html": "<h1>nope</h1>" },
      });
    expect(res.status).toBe(400);
  });

  it("resolves a linked design Action Item when the design is submitted", async () => {
    const resolveDesignSession = vi.fn(async () => undefined);
    const app = buildApp({
      resolveDesignSession,
      findById: async () => makeJob({ featureId: null, kind: "design_grill" }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_design",
        summary: "Finalized sign-in states",
        snapshot: { "designs/auth/page.html": "<h1>Sign in</h1>" },
      });

    expect(res.status).toBe(201);
    expect(resolveDesignSession).toHaveBeenCalledWith(
      JOB_ID,
      { "designs/auth/page.html": "<h1>Sign in</h1>" },
    );
  });

  it("finalizes the design index row when the design is submitted (ADR 020 item 4)", async () => {
    const finalizeDesign = vi.fn(async () => undefined);
    const app = buildApp({
      finalizeDesign,
      findById: async () =>
        makeJob({
          id: JOB_ID,
          featureId: null,
          kind: "design_grill",
          projectId: "proj_1",
          designName: "Sign in",
          designSlug: "auth",
        }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_design",
        summary: "Finalized sign-in states",
        prUrl: "https://github.com/acme/web/pull/9",
        snapshot: { "designs/auth/page.html": "<h1>Sign in</h1>" },
      });

    expect(res.status).toBe(201);
    // Keyed by (project, slug) rather than the design id, so this also repairs
    // a session whose index row was never written at start.
    expect(finalizeDesign).toHaveBeenCalledWith({
      projectId: "proj_1",
      name: "Sign in",
      slug: "auth",
      jobId: JOB_ID,
      prUrl: "https://github.com/acme/web/pull/9",
    });
  });

  it("passes a null PR url when the design session reported none", async () => {
    const finalizeDesign = vi.fn(async () => undefined);
    const app = buildApp({
      finalizeDesign,
      findById: async () =>
        makeJob({ featureId: null, kind: "design_grill", designName: "Auth", designSlug: "auth" }),
    });

    await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_design",
        summary: "done",
        snapshot: { "designs/auth/page.html": "<h1>Sign in</h1>" },
      });

    expect(finalizeDesign).toHaveBeenCalledWith(
      expect.objectContaining({ prUrl: null }),
    );
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
    expect(jobsCreate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "proj_1",
      kind: "spec_grill",
      featureId: "feature_42",
      specContext: expect.objectContaining({
        kickbackReason: "secret_request: Need an API key",
      }),
    }));
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

  it("dispatches feature-ref agentic and script test runs", async () => {
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
    expect(jobsCreate).toHaveBeenCalledTimes(4);
    expect(jobsCreate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: "test_run",
      testId: "test_1",
      ref: "yggdrasil/feature-feature_42",
    }));
    expect(jobsCreate).toHaveBeenNthCalledWith(3, expect.objectContaining({
      kind: "script_test_run",
      testGroup: "unit",
      ref: "yggdrasil/feature-feature_42",
    }));
    expect(jobsCreate).toHaveBeenNthCalledWith(4, expect.objectContaining({
      kind: "script_test_run",
      testGroup: "integration",
      ref: "yggdrasil/feature-feature_42",
    }));
  });

  /*
   * Issue #63. Two dispatches of one kind, so one capability decides both: an
   * install with no `script_test_run` image cannot execute either probe, and
   * dispatching them anyway is what creates two doomed job rows and, since #53,
   * a feature marked `failed` at Testing for a *setting* rather than a defect.
   */
  it("does not dispatch a script probe the installation cannot run", async () => {
    const setTesting = vi.fn(async () => ({ id: "feature_42" }));
    const jobsCreate = vi.fn(async () => ({ id: "test_job_1" }));
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "feature_build" }),
      setTesting: setTesting as never,
      jobsCreate,
      listEnabledTests: vi.fn(async () => [{ id: "test_1" }]),
      unrunnableKinds: ["script_test_run"],
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_build_result", status: "success" });

    expect(res.status).toBe(201);
    // The `test_run` for the enabled Test still goes out — only the probes that
    // cannot run are withheld.
    expect(jobsCreate).toHaveBeenCalledTimes(1);
    expect(jobsCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: "test_run" }));
    expect(jobsCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "script_test_run" }),
    );
  });

  it("dispatches both probes when the installation can run them", async () => {
    // The default, and unchanged from before #63: unknown capabilities must not
    // quietly stop dispatching, or an install that never publishes would silently
    // stop testing script groups.
    const setTesting = vi.fn(async () => ({ id: "feature_42" }));
    const jobsCreate = vi.fn(async () => ({ id: "test_job_1" }));
    const app = buildApp({
      findById: async () => makeJob({ featureId: "feature_42", kind: "feature_build" }),
      setTesting: setTesting as never,
      jobsCreate,
      listEnabledTests: vi.fn(async () => []),
      unrunnableKinds: [],
    });

    await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_build_result", status: "success" });

    expect(jobsCreate).toHaveBeenCalledTimes(2);
    expect(jobsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "script_test_run", testGroup: "unit" }),
    );
    expect(jobsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "script_test_run", testGroup: "integration" }),
    );
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

  /*
   * Issue #40: the gate is now derived from the *run list* rather than from the
   * reports it can see. This is the wiring test — the decision itself is
   * exhaustively covered in `features/testing-gate.test.ts` and
   * `testing-gate-runner.test.ts`. It exists because nothing asserted this
   * transition at all before, which is why the stuck-feature bug survived.
   */
  it("applies the Testing gate from the feature's run list on a submitted report", async () => {
    const setReturned = vi.fn(async () => null);
    const execution = {
      jobId: JOB_ID,
      testId: null,
      testGroup: "unit",
      status: "completed",
      lastError: null,
      completedAt: new Date(),
      steps: [],
      report: {
        jobId: JOB_ID,
        testId: null,
        passed: 3,
        failed: 1,
        skipped: 0,
        total: 4,
        coveragePercent: null,
        failingTests: ["auth rejects an expired token"],
        summary: "One unit test failed.",
        recordingPath: null,
        createdAt: new Date(),
        steps: [],
      },
    };
    const app = buildApp({
      upsertReport: vi.fn(async () => undefined),
      setReturned,
      listReportExecutions: vi.fn(async () => [execution]),
      featureStatus: "testing",
      findById: async () => makeJob({ kind: "test_run", featureId: "feature_42" }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_test_report",
        passed: 3,
        failed: 1,
        skipped: 0,
        total: 4,
        summary: "One unit test failed.",
        failingTests: ["auth rejects an expired token"],
      });

    expect(res.status).toBe(201);
    expect(setReturned).toHaveBeenCalledWith(
      "feature_42",
      "test_failure",
      expect.stringContaining("auth rejects an expired token"),
    );
  });

  it("does not apply the gate while the feature is not in testing", async () => {
    // The fake feature is `running`, which is the state a report cannot
    // legitimately arrive in (submit_build_result is what moves it to testing).
    const setReturned = vi.fn(async () => null);
    const app = buildApp({
      upsertReport: vi.fn(async () => undefined),
      setReturned,
      listReportExecutions: vi.fn(async () => [{
        jobId: JOB_ID,
        testId: null,
        testGroup: "unit",
        status: "completed",
        lastError: null,
        completedAt: new Date(),
        steps: [],
        report: null,
      }]),
      findById: async () => makeJob({ kind: "test_run", featureId: "feature_42" }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_test_report", passed: 1, failed: 0, summary: "ok" });

    expect(res.status).toBe(201);
    expect(setReturned).not.toHaveBeenCalled();
  });

  /*
   * Issue #53: the field that lets the gate tell "this project has no unit
   * tests" from "this install cannot run unit tests". Asserted here because it
   * crosses the wire — the Orchestrator sends it, the zod schema has to accept
   * it, and a rejection would be silent (the report still stores, just without
   * the reason), which is the failure mode that made the issue worth filing.
   */
  it("carries a skip reason from the wire onto the report", async () => {
    const upsertReport = vi.fn(async () => undefined);
    const app = buildApp({
      upsertReport,
      findById: async () => makeJob({
        kind: "script_test_run",
        featureId: "feature_42",
        testGroup: "unit",
      }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_test_report",
        passed: 0,
        failed: 0,
        skipped: 1,
        total: 1,
        summary: "Skipped (unit): this installation has no script_test_run image configured.",
        skipReason: "runner_unavailable",
      });

    expect(res.status).toBe(201);
    expect(upsertReport).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: "runner_unavailable" }),
    );
  });

  it("rejects an unknown skip reason rather than storing it", async () => {
    // The enum is closed on purpose: a typo'd value must fail loudly here, not
    // become a row the gate silently ignores and advances past.
    const upsertReport = vi.fn(async () => undefined);
    const app = buildApp({
      upsertReport,
      findById: async () => makeJob({ kind: "script_test_run", featureId: "feature_42" }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_test_report",
        passed: 0,
        failed: 0,
        summary: "no",
        skipReason: "image_missing",
      });

    expect(res.status).toBe(400);
    expect(upsertReport).not.toHaveBeenCalled();
  });

  // A producer that has not been updated yet must keep working unchanged — the
  // property that lets the API land ahead of the Orchestrator.
  it("accepts a report with no skip reason at all", async () => {
    const upsertReport = vi.fn(async () => undefined);
    const app = buildApp({
      upsertReport,
      findById: async () => makeJob({ kind: "script_test_run", featureId: "feature_42" }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "submit_test_report", passed: 1, failed: 0, summary: "fine" });

    expect(res.status).toBe(201);
    expect(upsertReport).toHaveBeenCalledWith(
      expect.objectContaining({ skipReason: undefined }),
    );
  });

  it("accepts a canonical report from a script test job", async () => {
    const upsertReport = vi.fn(async () => undefined);
    const app = buildApp({
      upsertReport,
      findById: async () => makeJob({
        kind: "script_test_run",
        featureId: "feature_42",
        testGroup: "unit",
      }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        type: "submit_test_report",
        passed: 3,
        failed: 1,
        skipped: 0,
        total: 4,
        summary: "One unit test failed.",
        failingTests: ["auth rejects expired token"],
      });

    expect(res.status).toBe(201);
    expect(upsertReport).toHaveBeenCalledWith(expect.objectContaining({
      jobId: JOB_ID,
      passed: 3,
      failed: 1,
      total: 4,
    }));
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

describe("POST /internal/jobs/:jobId/events (streaming deltas, ADR 019 item 13)", () => {
  it("relays a delta and stores nothing", async () => {
    // The defining property of the delta path: the Orchestrator's stream of
    // chunks is forwarded to the live relay, and not one of them becomes a
    // job_events row.
    const create = vi.fn(async () => makeEvent({}));
    const publishDelta = vi.fn(async () => undefined);
    const app = buildApp({
      create,
      publishDelta,
      findById: async () => makeJob({ id: JOB_ID, featureId: "feature_42" }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "agent_text_delta", message: "Drafting " });

    expect(res.status).toBe(202);
    // No row, and therefore no id to return.
    expect(res.body).toEqual({});
    expect(create).not.toHaveBeenCalled();
    expect(publishDelta).toHaveBeenCalledWith({
      featureId: "feature_42",
      jobId: JOB_ID,
      text: "Drafting ",
    });
  });

  it("does not become a storable event type", async () => {
    // `jobEventSchema`'s enum stays authoritative for what can be persisted. A
    // delta is accepted only by its own schema, so there is no request shape that
    // both stores and streams one.
    const create = vi.fn(async () => makeEvent({}));
    const app = buildApp({ create, publishDelta: vi.fn(async () => undefined) });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "agent_text", message: "the finished message" });

    // The stored path, unchanged: 201 and a row.
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalled();
  });

  it("derives the feature from the stored job, not from the request body", async () => {
    // Scope comes from the API's own data, as on the usage route: otherwise the
    // routing of one feature's text to another feature's subscribers would be
    // assertable from outside.
    const publishDelta = vi.fn(async () => undefined);
    const app = buildApp({
      findById: async () =>
        makeJob({ id: JOB_ID, featureId: "feature_from_db", projectId: "proj_1" }),
      publishDelta,
    });

    await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "agent_text_delta", message: "chunk", featureId: "feature_attacker" });

    expect(publishDelta).toHaveBeenCalledWith({
      featureId: "feature_from_db",
      jobId: JOB_ID,
      text: "chunk",
    });
  });

  it("drops a delta for a job with no feature", async () => {
    // ADR 014's project-scoped design_grill has no feature topic to route to.
    const publishDelta = vi.fn(async () => undefined);
    const app = buildApp({
      findById: async () => makeJob({ id: JOB_ID, featureId: null }),
      publishDelta,
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "agent_text_delta", message: "chunk" });

    expect(res.status).toBe(202);
    expect(publishDelta).not.toHaveBeenCalled();
  });

  it("drops a delta for a job that does not exist", async () => {
    const publishDelta = vi.fn(async () => undefined);
    const app = buildApp({ findById: async () => null, publishDelta });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "agent_text_delta", message: "chunk" });

    expect(res.status).toBe(202);
    expect(publishDelta).not.toHaveBeenCalled();
  });

  /*
   * Issue #24: the per-job delta byte ceiling. The boundary is stated as three
   * cases — under, at, over — because "there is a counter" is not the property
   * that matters; where it cuts is.
   *
   * The ceiling's failure behaviour is intentionally *not* the per-socket
   * budget's: exceeding it stops relaying that job's deltas rather than closing
   * subscribers' sockets, because a runaway is the producer's problem and the
   * people watching the feature did nothing. What makes that safe is that the
   * authoritative `agent_text` still arrives over the stored-event path, so the
   * cost is immediacy and never content — asserted here so the claim is not just
   * a comment.
   */
  describe("per-job delta ceiling (issue #24)", () => {
    const postDelta = (app: express.Express, message: string) =>
      request(app)
        .post(`/internal/jobs/${JOB_ID}/events`)
        .set("Authorization", "Bearer test-internal-api-token")
        .send({ type: "agent_text_delta", message });

    it("relays deltas that keep the job under the ceiling", async () => {
      const publishDelta = vi.fn(async () => undefined);
      const app = buildApp({
        publishDelta,
        deltaBytesPerJob: 100,
        // 99 bytes: the last value that is still strictly under.
        deltaBytes: 50,
        deltaBytesPerCall: 49,
      });

      expect((await postDelta(app, "chunk")).status).toBe(202);
      expect(publishDelta).toHaveBeenCalledTimes(1);
    });

    it("relays the delta that lands exactly on the ceiling", async () => {
      // `total > ceiling`, not `>=`: landing on the limit is permitted, and
      // getting this wrong by one byte is the kind of off-by-one that a limit
      // test exists to pin. The next byte over is refused (below).
      const publishDelta = vi.fn(async () => undefined);
      const app = buildApp({
        publishDelta,
        deltaBytesPerJob: 100,
        deltaBytes: 50,
        deltaBytesPerCall: 50,
      });

      expect((await postDelta(app, "chunk")).status).toBe(202);
      expect(publishDelta).toHaveBeenCalledTimes(1);
    });

    it("stops relaying once the job is over the ceiling", async () => {
      const publishDelta = vi.fn(async () => undefined);
      const app = buildApp({
        publishDelta,
        deltaBytesPerJob: 100,
        deltaBytes: 50,
        deltaBytesPerCall: 51,
      });

      // Still 202: the caller cannot tell a relayed delta from a dropped one,
      // and it must not — failing the request would report an error the agent
      // has no way to act on.
      expect((await postDelta(app, "chunk")).status).toBe(202);
      expect(publishDelta).not.toHaveBeenCalled();
    });

    it("lets the authoritative agent_text through after deltas stop", async () => {
      // The property that makes stopping safe. Same job, over its delta ceiling,
      // and a stored event still relays — so the bubble ends up correct and only
      // arrives later.
      const publishDelta = vi.fn(async () => undefined);
      const createEvent = vi.fn(async (input: { jobId: string; type: string }) => ({
        id: "event_1",
        jobId: input.jobId,
        type: input.type,
      }));
      const app = express();
      app.use(express.json());
      app.use(
        "/internal",
        createJobsInternalRouter({
          jobEvents: { create: createEvent } as never,
          jobs: {
            findById: async () => makeJob({ featureId: "feature_42" }),
            recordRelayedDeltaBytes: async () => ({
              featureId: "feature_42",
              previousBytes: 500,
              totalBytes: 501,
            }),
          } as never,
          features: {} as never,
          actionItems: {} as never,
          tests: {} as never,
          testRunReports: {} as never,
          projects: {} as never,
          designs: {} as never,
          usage: {} as never,
          modelConfig: {} as never,
          live: { publishDelta } as never,
          deltaBytesPerJob: 100,
        }),
      );

      // A delta for the over-ceiling job is not relayed...
      expect((await postDelta(app, "chunk")).status).toBe(202);
      expect(publishDelta).not.toHaveBeenCalled();

      // ...but the stored event for the same job is, which is the whole reason
      // the ceiling can drop deltas without losing content.
      const res = await request(app)
        .post(`/internal/jobs/${JOB_ID}/events`)
        .set("Authorization", "Bearer test-internal-api-token")
        .send({ type: "agent_text", message: "the complete answer" });

      expect(res.status).toBe(201);
      expect(createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent_text", message: "the complete answer" }),
      );
    });

    it("treats a ceiling of zero as switched off, not as zero bytes allowed", async () => {
      // The convention `RECORDING_MAX_BYTES` already sets in this codebase: 0 is
      // an instruction ("no ceiling"), not an unset value. Reading it as "zero
      // permitted" would silently disable the whole delta path for anyone who
      // set it that way.
      const publishDelta = vi.fn(async () => undefined);
      const app = buildApp({
        publishDelta,
        deltaBytesPerJob: 0,
        deltaBytes: 10_000_000,
        deltaBytesPerCall: 10_000_000,
      });

      expect((await postDelta(app, "chunk")).status).toBe(202);
      expect(publishDelta).toHaveBeenCalledTimes(1);
    });

    it("does not relay a delta for a job with no feature", async () => {
      // ADR 014's project-scoped design_grill has no feature topic to route to.
      // The counter still advances — the job did produce the text — but there is
      // nothing to publish it to.
      const publishDelta = vi.fn(async () => undefined);
      const app = buildApp({
        publishDelta,
        recordRelayedDeltaBytes: vi.fn(async () => ({
          featureId: null,
          previousBytes: 0,
          totalBytes: 5,
        })),
      });

      expect((await postDelta(app, "chunk")).status).toBe(202);
      expect(publishDelta).not.toHaveBeenCalled();
    });

    it("logs the crossing once per job, not once per delta", async () => {
      // A limit that floods the log while enforcing itself has just moved the
      // problem. The `previousBytes` the atomic update returns is what makes
      // "exactly once" implementable without an in-memory set of warned jobs
      // (which would grow without bound and be per-replica anyway).
      const publishDelta = vi.fn(async () => undefined);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // First call crosses from 50 → 101; every later call stays over.
        let previous = 50;
        const app = buildApp({
          publishDelta,
          deltaBytesPerJob: 100,
          recordRelayedDeltaBytes: vi.fn(async () => {
            const total = previous + 51;
            const result = { featureId: "feature_42", previousBytes: previous, totalBytes: total };
            previous = total;
            return result;
          }),
        });

        for (let i = 0; i < 5; i += 1) {
          expect((await postDelta(app, "chunk")).status).toBe(202);
        }

        const ceilingLogs = errorSpy.mock.calls.filter((call) =>
          String(call[0]).includes("exceeded the per-job delta ceiling"),
        );
        expect(ceilingLogs).toHaveLength(1);
        expect(publishDelta).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  it("still answers 202 when the relay itself fails", async () => {
    // Best-effort by contract: the delta is ephemeral and the client has a REST
    // catch-up, so a relay failure must not report an error the agent cannot act
    // on — nor make the Orchestrator treat a streaming chunk as job-fatal.
    const create = vi.fn(async () => makeEvent({}));
    const publishDelta = vi.fn(async () => {
      throw new Error("notify failed");
    });
    const app = buildApp({ create, publishDelta });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "agent_text_delta", message: "chunk" });

    expect(res.status).toBe(202);
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an empty or oversize delta rather than relaying it", async () => {
    const publishDelta = vi.fn(async () => undefined);
    const app = buildApp({ publishDelta });

    for (const message of ["", "x".repeat(5_000)]) {
      const res = await request(app)
        .post(`/internal/jobs/${JOB_ID}/events`)
        .set("Authorization", "Bearer test-internal-api-token")
        .send({ type: "agent_text_delta", message });

      // Falls through to the stored-event schema, which rejects the type — so a
      // malformed delta is a 400 rather than a silently forwarded no-op.
      expect(res.status).toBe(400);
    }
    expect(publishDelta).not.toHaveBeenCalled();
  });

  it("requires the internal bearer token", async () => {
    const publishDelta = vi.fn(async () => undefined);
    const app = buildApp({ publishDelta });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .send({ type: "agent_text_delta", message: "chunk" });

    expect(res.status).toBe(401);
    expect(publishDelta).not.toHaveBeenCalled();
  });

  it("404s a delta for a job id that is not a uuid", async () => {
    const app = buildApp({ publishDelta: vi.fn(async () => undefined) });

    const res = await request(app)
      .post("/internal/jobs/not-a-uuid/events")
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "agent_text_delta", message: "chunk" });

    expect(res.status).toBe(404);
  });

  it("accepts a delta at default when no publisher is configured", async () => {
    // The relay-off path: same status, nothing published, no error. A job must
    // not break because the live relay is switched off.
    const app = express();
    app.use(express.json());
    app.use(
      "/internal",
      createJobsInternalRouter({
        jobEvents: { create: async () => makeEvent({}) } as never,
        jobs: {
          findById: async () => makeJob({ featureId: "feature_42" }),
          recordRelayedDeltaBytes: async () => ({
            featureId: "feature_42",
            previousBytes: 0,
            totalBytes: 6,
          }),
        } as never,
        features: {} as never,
        actionItems: {} as never,
        tests: {} as never,
        testRunReports: {} as never,
        projects: {} as never,
        designs: {} as never,
        usage: {} as never,
        modelConfig: {} as never,
      }),
    );

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/events`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ type: "agent_text_delta", message: "chunk" });

    expect(res.status).toBe(202);
  });
});

describe("POST /internal/jobs/:jobId/usage", () => {
  const validUsage = {
    modelId: "anthropic/claude-sonnet-4",
    inputTokens: 50_000,
    outputTokens: 10_000,
    cacheReadTokens: 40_000,
    cacheWriteTokens: 5_000,
    totalTokens: 105_000,
    costUsd: 0.45,
    durationMs: 90_000,
  };

  it("records the accounting against the stored job, not the request body", async () => {
    let gotInput: Record<string, unknown> | undefined;
    const app = buildApp({
      upsertUsage: vi.fn(async (input: Record<string, unknown>) => {
        gotInput = input;
        return { jobId: input.jobId };
      }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/usage`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send(validUsage);

    expect(res.status).toBe(201);
    // Scope comes from the job row: a caller cannot attribute usage to a
    // project or kind it did not actually run.
    expect(gotInput?.jobId).toBe(JOB_ID);
    expect(gotInput?.projectId).toBe("project_1");
    expect(gotInput?.jobKind).toBe("spec_grill");
    expect(gotInput?.totalTokens).toBe(105_000);
    expect(gotInput?.costUsd).toBe(0.45);
    expect(gotInput?.durationMs).toBe(90_000);
  });

  it("attributes the provider and tier from the API's own catalog", async () => {
    let gotInput: Record<string, unknown> | undefined;
    const app = buildApp({
      jobDefaultModelId: "model_1",
      catalogModel: { providerName: "OpenRouter" },
      upsertUsage: vi.fn(async (input: Record<string, unknown>) => {
        gotInput = input;
        return { jobId: input.jobId };
      }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/usage`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send(validUsage);

    expect(res.status).toBe(201);
    expect(gotInput?.modelConfigSource).toBe("organization_default");
    expect(gotInput?.providerName).toBe("OpenRouter");
    // The literal model id comes from the Orchestrator (what actually ran);
    // the provider comes from the catalog. Neither is taken from the other.
    expect(gotInput?.modelId).toBe("anthropic/claude-sonnet-4");
  });

  it("records no tier for a kind that resolves no model config", async () => {
    let gotInput: Record<string, unknown> | undefined;
    const app = buildApp({
      findById: async () =>
        makeJob({ id: JOB_ID, kind: "design_grill", featureId: null }),
      jobDefaultModelId: "model_1",
      catalogModel: { providerName: "OpenRouter" },
      upsertUsage: vi.fn(async (input: Record<string, unknown>) => {
        gotInput = input;
        return { jobId: input.jobId };
      }),
    });

    await request(app)
      .post(`/internal/jobs/${JOB_ID}/usage`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send(validUsage);

    // design_grill IS an agent kind, so it does resolve one; the point here is
    // that the tier is resolved from the job's own kind and feature, and a
    // design job carries no feature.
    expect(gotInput?.modelConfigSource).toBe("organization_default");
  });

  it("rejects negative counts rather than storing them", async () => {
    const app = buildApp({});

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/usage`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ ...validUsage, inputTokens: -1 });

    expect(res.status).toBe(400);
  });

  it("rejects a payload missing token counts", async () => {
    const app = buildApp({});

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/usage`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({ modelId: "x" });

    expect(res.status).toBe(400);
  });

  it("accepts an unreported cost and duration as null", async () => {
    let gotInput: Record<string, unknown> | undefined;
    const app = buildApp({
      upsertUsage: vi.fn(async (input: Record<string, unknown>) => {
        gotInput = input;
        return { jobId: input.jobId };
      }),
    });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/usage`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
        costUsd: null,
        durationMs: null,
      });

    expect(res.status).toBe(201);
    expect(gotInput?.costUsd).toBeNull();
    expect(gotInput?.durationMs).toBeNull();
  });

  it("404s an unknown job without writing a row", async () => {
    const upsertUsage = vi.fn(async () => ({ jobId: JOB_ID }));
    const app = buildApp({ findById: async () => null, upsertUsage });

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/usage`)
      .set("Authorization", "Bearer test-internal-api-token")
      .send(validUsage);

    expect(res.status).toBe(404);
    expect(upsertUsage).not.toHaveBeenCalled();
  });

  it("requires the internal bearer token", async () => {
    const app = buildApp({});

    const res = await request(app).post(`/internal/jobs/${JOB_ID}/usage`).send(validUsage);

    expect(res.status).toBe(401);
  });
});
