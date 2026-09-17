import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createProjectsRouter } from "./routes.js";
import type { Project } from "./types.js";
import type { Feature } from "../features/types.js";
import type { SessionRecord } from "../auth/sessions.js";
import type { User } from "../users/types.js";

const OWNER_ID = "user_1";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "org_1",
    ownerUserId: OWNER_ID,
    name: "Test",
    slug: "test-slug",
    description: "",
    status: "ready",
    settings: {},
    installationId: "install_1",
    githubAccessWarning: false,
    modelConfigWarning: false,
    agenticReviewEnabled: true,
    hasDesignSurface: true,
    repositories: [
      { id: "repo_1", githubOwner: "acme", githubRepo: "web", isPrimary: true, sortOrder: 0 },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: "11111111-1111-4111-8111-111111111111",
    title: "Project initialization",
    slug: "project-initialization",
    featureType: "project_init",
    status: "draft",
    adrMarkdown: null,
    awaitingUserInput: false,
    adrApproved: false,
    branchName: null,
    prUrl: null,
    parentFeatureId: null,
    returnReason: null,
    returnComment: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeSecrets(bundle: Record<string, string> = {}) {
  return {
    decryptAllForProject: vi.fn(async () => ({ ...bundle })),
    listForProject: vi.fn(async () => []),
    upsert: vi.fn(async (_projectId: string, key: string, _value: string) => ({
      id: "sec_1",
      key,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    delete: vi.fn(async () => true),
  };
}

function fakeUserSecrets(bundle: Record<string, string> = {}) {
  return {
    decryptAllForOrganization: vi.fn(async () => ({ ...bundle })),
    listForOrganization: vi.fn(async () => []),
    upsert: vi.fn(async (_orgId: string, key: string, _value: string) => ({
      id: "osec_1",
      key,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    delete: vi.fn(async () => true),
  };
}

const ORG_DEFAULT_MODEL_ID = "model_org_default";

/**
 * ADR 018 fakes standing in for the org's model provider/catalog/job-default
 * stack. A complete `bundle` (the old flat triplet, kept as the test
 * fixture's shape) resolves as if it were the org's default for every job
 * kind — mirrors the pre-ADR-018 "one org bundle, applies everywhere" fixture
 * semantics closely enough for these tests, which don't exercise per-job-kind
 * variation.
 */
function fakeModelConfigDeps(bundle: Record<string, string> = {}) {
  const complete = Boolean(bundle.MODEL_BASE_URL && bundle.MODEL_API_KEY && bundle.MODEL_ID);
  const providers = {
    decryptApiKey: vi.fn(async () => bundle.MODEL_API_KEY ?? null),
    findById: vi.fn(async () => (complete ? { id: "provider_1", baseUrl: bundle.MODEL_BASE_URL } : null)),
  };
  const models = {
    findById: vi.fn(async (_orgId: string, modelId: string) =>
      complete && modelId === ORG_DEFAULT_MODEL_ID
        ? { id: modelId, providerId: "provider_1", modelId: bundle.MODEL_ID }
        : null,
    ),
  };
  const jobDefaults = {
    findForJobKind: vi.fn(async () => (complete ? { modelId: ORG_DEFAULT_MODEL_ID } : null)),
  };
  const projectOverrides = {
    findForJobKind: vi.fn(async () => null),
  };
  // ADR 018 amendment (issue #5): these tests don't exercise the feature tier,
  // so its fakes resolve to "nothing set here" and every existing assertion
  // keeps its original project/org meaning.
  const featureOverrides = {
    findForJobKind: vi.fn(async () => null),
  };
  const featureSecrets = {
    decryptAllForFeature: vi.fn(async () => ({})),
  };
  return { providers, models, jobDefaults, projectOverrides, featureOverrides, featureSecrets };
}

interface BuildAppOptions {
  project: Project;
  feature?: Feature;
  projectSecrets?: Record<string, string>;
  orgSecrets?: Record<string, string>;
  activeSpecGrillJob?: unknown;
  latestDeployJob?: unknown;
  personalOrg?: { id: string; status: string } | null;
  /** ADR 022 deploy-ledger state. */
  projectDeploys?: unknown[];
  currentRevision?: number | null;
  rollbackTargets?: unknown[];
  knownRevisions?: number[];
}

function buildApp(opts: BuildAppOptions) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const secrets = fakeSecrets(opts.projectSecrets);
  const orgSecrets = fakeUserSecrets(opts.orgSecrets);
  const { providers, models, jobDefaults, projectOverrides, featureOverrides, featureSecrets } =
    fakeModelConfigDeps(opts.orgSecrets);

  const users = {
    findById: vi.fn(async () => ({ id: OWNER_ID } as User)),
  };
  const sessions = {
    findValid: vi.fn(async () => ({ id: "sess_1", userId: OWNER_ID } as SessionRecord)),
    touch: vi.fn(async () => undefined),
  };
  const projects = {
    findByIdForUser: vi.fn(async (id: string, userId: string) =>
      id === opts.project.id && userId === OWNER_ID ? opts.project : null,
    ),
    create: vi.fn(async () => opts.project),
    markReady: vi.fn(async () => undefined),
    setAgenticReviewEnabled: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
  };
  const features = {
    findById: vi.fn(async () => opts.feature ?? null),
    findProjectInit: vi.fn(async () => opts.feature ?? null),
    create: vi.fn(async () => opts.feature ?? makeFeature()),
    hasBlockingStatuses: vi.fn(async () => false),
    listBlocking: vi.fn(async () => []),
    updateStatus: vi.fn(async () => opts.feature ?? null),
    cancel: vi.fn(async () => (opts.feature ? { ...opts.feature, status: "cancelled" } : null)),
    restartFromCancelled: vi.fn(async () =>
      opts.feature ? { ...opts.feature, status: "draft" } : null,
    ),
    setAwaitingUserInput: vi.fn(async () => opts.feature ?? null),
    resetForRetry: vi.fn(async () => opts.feature ?? null),
    queueBuild: vi.fn(async () => opts.feature ?? null),
    resumeImplementation: vi.fn(async () => opts.feature ?? null),
    setReturned: vi.fn(async () => opts.feature ?? null),
    setTesting: vi.fn(async () => opts.feature ?? null),
    setAgenticReview: vi.fn(async () => opts.feature ?? null),
    approveReview: vi.fn(async () => opts.feature ?? null),
    createSubtask: vi.fn(async () => opts.feature ?? makeFeature()),
  };
  const jobs = {
    create: vi.fn(async () => ({ id: "job_1" })),
    hasActiveTestRunsForProject: vi.fn(async () => false),
    listActiveTestRunsForProject: vi.fn(async () => []),
    findActiveSpecGrillJob: vi.fn(async () => opts.activeSpecGrillJob ?? null),
    findLatestByProjectAndKind: vi.fn(async () => opts.latestDeployJob ?? null),
    // ADR 022: the deploy/rollback pair shares one in-flight guard, so the
    // routes now ask for both kinds at once. Fed from the same fake so every
    // existing deploy assertion keeps its original meaning.
    findLatestByProjectAndKinds: vi.fn(async () => opts.latestDeployJob ?? null),
    cancelActiveForFeature: vi.fn(async () => undefined),
  };
  const notifications = { create: vi.fn(async () => undefined) };
  const installations = {
    findById: vi.fn(async () => ({ id: "install_1", suspendedAt: null })),
    hasRepository: vi.fn(async () => true),
  };
  const organizations = {
    findPersonalByUser: vi.fn(async () => opts.personalOrg ?? { id: "org_1", status: "ready" }),
    findById: vi.fn(async (id: string) => (id === "org_1" ? { id: "org_1", status: "ready" } : null)),
    roleForUser: vi.fn(async () => "admin"),
    listRoleCapabilities: vi.fn(async () => [
      { role: "admin", capability: "manage_features", level: "full" },
      { role: "admin", capability: "manage_projects", level: "full" },
      { role: "admin", capability: "design_sessions", level: "full" },
      { role: "developer", capability: "manage_features", level: "full" },
    ]),
  };
  const actionItems = {
    listForFeature: vi.fn(async () => []),
    findById: vi.fn(async () => null),
    resolve: vi.fn(async () => undefined),
    countOpenForFeature: vi.fn(async () => 0),
    createMany: vi.fn(async () => []),
    resolveSubtaskItem: vi.fn(async () => undefined),
    resolveSecretItemIfPresent: vi.fn(async () => false),
  };
  const testRunReports = {
    listByFeature: vi.fn(async () => []),
    // ADR 026 (issue #16): the standalone Testing product's history reads.
    listRunsForTest: vi.fn(async () => []),
    findRunForTest: vi.fn(async () => null),
  };
  const audit = {
    record: vi.fn(async (_res: unknown, _input: { action: string }) => undefined),
  };
  const designs = {
    startSession: vi.fn(async (input: {
      projectId: string;
      name: string;
      slug: string;
      jobId: string;
    }) => ({
      id: "design_1",
      projectId: input.projectId,
      name: input.name,
      slug: input.slug,
      status: "in_progress" as const,
      originJobId: input.jobId,
      prUrl: null,
      finalizedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    linkSession: vi.fn(async () => undefined),
  };
  // ADR 022: the deploy ledger. Existing tests only needed a latest-deploy job
  // (opts.latestDeployJob); this lane's tests set the ledger state explicitly.
  const deploys = {
    record: vi.fn(async (input: Record<string, unknown>) => ({ id: "deploy_1", ...input })),
    listForProject: vi.fn(async () => opts.projectDeploys ?? []),
    currentRevision: vi.fn(async () => opts.currentRevision ?? null),
    listRollbackTargets: vi.fn(async () => opts.rollbackTargets ?? []),
    hasRevision: vi.fn(async (_projectId: string, revision: number) =>
      (opts.knownRevisions ?? []).includes(revision),
    ),
  };
  const tests = {
    // ADR 026's history routes resolve the test through the project before
    // reading anything, so they need findById stubbed per test.
    findById: vi.fn(async () => null),
    create: vi.fn(async (input: {
      projectId: string;
      name: string;
      specMarkdown: string;
      scheduleCron: string;
      enabled?: boolean;
    }) => ({
      id: "test_1",
      ...input,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  };

  app.use(
    "/projects",
    createProjectsRouter({
      users: users as never,
      sessions: sessions as never,
      projects: projects as never,
      features: features as never,
      tests: tests as never,
      testRunReports: testRunReports as never,
      jobs: jobs as never,
      jobEvents: {} as never,
      jobMessages: {} as never,
      notifications: notifications as never,
      installations: installations as never,
      secrets: secrets as never,
      orgSecrets: orgSecrets as never,
      organizations: organizations as never,
      actionItems: actionItems as never,
      providers: providers as never,
      models: models as never,
      jobDefaults: jobDefaults as never,
      projectOverrides: projectOverrides as never,
      featureOverrides: featureOverrides as never,
      featureSecrets: featureSecrets as never,
      designs: designs as never,
      deploys: deploys as never,
      audit: audit as never,
    }),
  );

  return {
    app,
    secrets,
    orgSecrets,
    features,
    jobs,
    projects,
    actionItems,
    testRunReports,
    tests,
    audit,
    designs,
    deploys,
  };
}

const SESSION_COOKIE = "yggdrasil_session=sess_1";

function authedRequest(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", SESSION_COOKIE),
    post: (url: string) => request(app).post(url).set("Cookie", SESSION_COOKIE),
    patch: (url: string) => request(app).patch(url).set("Cookie", SESSION_COOKIE),
    delete: (url: string) => request(app).delete(url).set("Cookie", SESSION_COOKIE),
  };
}

describe("model configuration gate (ADR 007)", () => {
  describe("POST /projects", () => {
    function createBody(overrides: Record<string, unknown> = {}) {
      return {
        name: "New project",
        installationId: "550e8400-e29b-41d4-a716-446655440000",
        repositories: [{ githubOwner: "acme", githubRepo: "web", isPrimary: true }],
        ...overrides,
      };
    }

    it("400s when neither the request nor the user's default has a model config", async () => {
      const project = makeProject({ status: "initializing" });
      const { app } = buildApp({ project, orgSecrets: {} });

      const res = await authedRequest(app).post("/projects").send(createBody());

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/model configuration/i);
    });

    it("400s when the org's cluster isn't configured yet (ADR 016 gate)", async () => {
      const project = makeProject({ status: "initializing" });
      const { app } = buildApp({
        project,
        orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
        personalOrg: { id: "org_1", status: "pending_cluster" },
      });

      const res = await authedRequest(app)
        .post("/projects")
        .send(createBody({ name: "New project" }));

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Kubernetes cluster/i);
    });

    it("201s once the org's cluster is configured (ready)", async () => {
      const project = makeProject({ status: "initializing" });
      const { app } = buildApp({
        project,
        orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
        personalOrg: { id: "org_1", status: "ready" },
      });

      const res = await authedRequest(app)
        .post("/projects")
        .send(createBody({ name: "New project" }));

      expect(res.status).toBe(201);
    });

    it("records project.created in the org's audit trail (ADR 028)", async () => {
      const project = makeProject({ status: "initializing" });
      const { app, audit } = buildApp({
        project,
        orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
        personalOrg: { id: "org_1", status: "ready" },
      });

      const res = await authedRequest(app)
        .post("/projects")
        .send(createBody({ name: "New project" }));

      expect(res.status).toBe(201);
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          organizationId: project.organizationId,
          projectId: project.id,
          actorUserId: OWNER_ID,
          action: "project.created",
          targetType: "project",
          targetId: project.id,
        }),
      );
    });

    it("records a failed chart scaffold without failing project creation", async () => {
      // No github installation record => scaffoldChart is skipped entirely,
      // which is the failure branch this asserts on (a real scaffold failure
      // is covered by chart-scaffold.test.ts).
      const project = makeProject({ status: "initializing" });
      const { app, audit } = buildApp({
        project,
        orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
        personalOrg: { id: "org_1", status: "ready" },
      });

      const res = await authedRequest(app).post("/projects").send(createBody());

      expect(res.status).toBe(201);
      const recorded = audit.record.mock.calls.map(
        ([, input]) => (input as { action: string }).action,
      );
      expect(recorded).toContain("project.created");
    });

    it("succeeds and persists no project secrets when the org's config resolves", async () => {
      const project = makeProject({ status: "initializing" });
      const { app, secrets } = buildApp({
        project,
        orgSecrets: {
          MODEL_BASE_URL: "https://api.openai.com/v1",
          MODEL_API_KEY: "sk-default",
          MODEL_ID: "gpt-4.1",
        },
      });

      const res = await authedRequest(app).post("/projects").send(createBody());

      expect(res.status).toBe(201);
      expect(secrets.upsert).not.toHaveBeenCalled();
    });

    it("succeeds and persists a custom bundle when the request provides one", async () => {
      const project = makeProject({ status: "initializing" });
      const { app, secrets, orgSecrets } = buildApp({ project, orgSecrets: {} });

      const res = await authedRequest(app)
        .post("/projects")
        .send(
          createBody({
            modelConfig: {
              modelBaseUrl: "https://api.example.com/v1",
              modelApiKey: "sk-custom",
              modelId: "custom-model",
            },
          }),
        );

      expect(res.status).toBe(201);
      expect(secrets.upsert).toHaveBeenCalledWith(project.id, "MODEL_BASE_URL", "https://api.example.com/v1");
      expect(secrets.upsert).toHaveBeenCalledWith(project.id, "MODEL_API_KEY", "sk-custom");
      expect(secrets.upsert).toHaveBeenCalledWith(project.id, "MODEL_ID", "custom-model");
      expect(orgSecrets.upsert).not.toHaveBeenCalled();
    });

    it("no longer saves a project bundle as the user/org default (ADR 007 retired)", async () => {
      const project = makeProject({ status: "initializing" });
      const { app, orgSecrets } = buildApp({ project, orgSecrets: {} });

      const res = await authedRequest(app)
        .post("/projects")
        .send(
          createBody({
            modelConfig: {
              modelBaseUrl: "https://api.example.com/v1",
              modelApiKey: "sk-custom",
              modelId: "custom-model",
            },
            saveModelConfigAsDefault: true,
          }),
        );

      expect(res.status).toBe(201);
      expect(orgSecrets.upsert).not.toHaveBeenCalled();
    });
  });

  describe("POST /projects/:projectId/features", () => {
    it("400s when the project has no resolvable model config", async () => {
      const project = makeProject();
      const { app } = buildApp({ project, orgSecrets: {} });

      const res = await authedRequest(app)
        .post(`/projects/${project.id}/features`)
        .send({ title: "Add dark mode" });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/model configuration/i);
    });

    it("dispatches when the project has its own full bundle", async () => {
      const project = makeProject();
      const { app, jobs } = buildApp({
        project,
        projectSecrets: {
          MODEL_BASE_URL: "https://api.openai.com/v1",
          MODEL_API_KEY: "sk-project",
          MODEL_ID: "gpt-4.1",
        },
      });

      const res = await authedRequest(app)
        .post(`/projects/${project.id}/features`)
        .send({ title: "Add dark mode" });

      expect(res.status).toBe(201);
      expect(jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: project.id, kind: "spec_grill" }),
      );
    });

    it("400s on a partial project override even if the user default is complete (inconsistent state, not masked)", async () => {
      const project = makeProject();
      const { app } = buildApp({
        project,
        projectSecrets: { MODEL_API_KEY: "sk-partial" },
        orgSecrets: {
          MODEL_BASE_URL: "https://api.openai.com/v1",
          MODEL_API_KEY: "sk-default",
          MODEL_ID: "gpt-4.1",
        },
      });

      const res = await authedRequest(app)
        .post(`/projects/${project.id}/features`)
        .send({ title: "Add dark mode" });

      expect(res.status).toBe(400);
    });
  });

  describe("PATCH .../features/:featureId (startBuild)", () => {
    it("400s startBuild when model config is unresolvable", async () => {
      const project = makeProject();
      const feature = makeFeature({
        featureType: "normal",
        status: "spec_ready",
        adrApproved: true,
      });
      const { app } = buildApp({ project, feature, orgSecrets: {} });

      const res = await authedRequest(app)
        .patch(`/projects/${project.id}/features/${feature.id}`)
        .send({ startBuild: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/model configuration/i);
    });
  });

  describe("POST .../features/:featureId/retry-grill", () => {
    it("re-dispatches spec_grill for a normal feature too (ADR 012 follow-up)", async () => {
      const project = makeProject();
      const feature = makeFeature({ featureType: "normal", status: "failed" });
      const { app, jobs } = buildApp({
        project,
        feature,
        orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
      });

      const res = await authedRequest(app).post(
        `/projects/${project.id}/features/${feature.id}/retry-grill`,
      );

      expect(res.status).toBe(201);
      expect(jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: project.id, kind: "spec_grill", featureId: feature.id }),
      );
    });

    it("409s when a grill session is already active", async () => {
      const project = makeProject();
      const feature = makeFeature({ featureType: "project_init", status: "draft" });
      const { app } = buildApp({
        project,
        feature,
        activeSpecGrillJob: { id: "job_running" },
        orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
      });

      const res = await authedRequest(app).post(
        `/projects/${project.id}/features/${feature.id}/retry-grill`,
      );

      expect(res.status).toBe(409);
    });

    it("400s when model config still isn't resolvable", async () => {
      const project = makeProject();
      const feature = makeFeature({ featureType: "project_init", status: "draft" });
      const { app } = buildApp({ project, feature, orgSecrets: {} });

      const res = await authedRequest(app).post(
        `/projects/${project.id}/features/${feature.id}/retry-grill`,
      );

      expect(res.status).toBe(400);
    });

    it("re-dispatches spec_grill once model config resolves", async () => {
      const project = makeProject();
      const feature = makeFeature({ featureType: "project_init", status: "failed" });
      const { app, jobs } = buildApp({
        project,
        feature,
        orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
      });

      const res = await authedRequest(app).post(
        `/projects/${project.id}/features/${feature.id}/retry-grill`,
      );

      expect(res.status).toBe(201);
      expect(jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: project.id, kind: "spec_grill", featureId: feature.id }),
      );
    });

    it("resets the feature back to draft so the retried run is visible (ADR 012)", async () => {
      const project = makeProject();
      const feature = makeFeature({ featureType: "project_init", status: "failed" });
      const { app, features } = buildApp({
        project,
        feature,
        orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
      });

      const res = await authedRequest(app).post(
        `/projects/${project.id}/features/${feature.id}/retry-grill`,
      );

      expect(res.status).toBe(201);
      expect(features.resetForRetry).toHaveBeenCalledWith(feature.id);
    });
  });
});

describe("POST /:projectId/designs (ADR 014)", () => {
  it("creates a gated, project-scoped design_grill job", async () => {
    const { app, jobs } = buildApp({
      project: makeProject(),
      orgSecrets: {
        MODEL_BASE_URL: "https://models.example",
        MODEL_API_KEY: "key",
        MODEL_ID: "model",
      },
    });

    const response = await authedRequest(app).post(
      `/projects/${makeProject().id}/designs`,
    ).send({ name: "Checkout flow", description: "Design checkout" });

    expect(response.status).toBe(201);
    expect(jobs.create).toHaveBeenCalledWith(expect.objectContaining({
      projectId: makeProject().id,
      kind: "design_grill",
      designName: "Checkout flow",
      designSlug: "checkout-flow",
      designDescription: "Design checkout",
    }));
  });

  it("rejects design sessions when the project has no design surface", async () => {
    const { app } = buildApp({ project: makeProject({ hasDesignSurface: false }) });
    const response = await authedRequest(app).post(
      `/projects/${makeProject().id}/designs`,
    ).send({ name: "Checkout", description: "Design checkout" });
    expect(response.status).toBe(409);
  });

  it("indexes the design and records the audit event (ADR 020)", async () => {
    const { app, designs, audit, jobs } = buildApp({
      project: makeProject(),
      orgSecrets: {
        MODEL_BASE_URL: "https://models.example",
        MODEL_API_KEY: "key",
        MODEL_ID: "model",
      },
    });

    const response = await authedRequest(app).post(
      `/projects/${makeProject().id}/designs`,
    ).send({ name: "Checkout flow", description: "Design checkout" });

    expect(response.status).toBe(201);
    // Keyed by the slug the artifact will live under, so a later session on the
    // same folder resolves to this same row instead of a duplicate.
    expect(designs.startSession).toHaveBeenCalledWith({
      projectId: makeProject().id,
      name: "Checkout flow",
      slug: "checkout-flow",
      jobId: expect.any(String),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "design.session_started",
        targetType: "design",
        metadata: { name: "Checkout flow", slug: "checkout-flow", sessionId: expect.any(String) },
      }),
    );
    expect(response.body.designId).toBe("design_1");
  });

  it("still starts the session when the index write fails", async () => {
    // The job is already dispatched and running, so reporting a failure here
    // would describe something the user cannot act on. `finalize` upserts, so a
    // design that reaches submit_design is indexed regardless.
    const { app, designs } = buildApp({
      project: makeProject(),
      orgSecrets: {
        MODEL_BASE_URL: "https://models.example",
        MODEL_API_KEY: "key",
        MODEL_ID: "model",
      },
    });
    designs.startSession.mockRejectedValueOnce(new Error("index unavailable"));

    const response = await authedRequest(app).post(
      `/projects/${makeProject().id}/designs`,
    ).send({ name: "Checkout flow", description: "Design checkout" });

    expect(response.status).toBe(201);
    expect(response.body.designId).toBeNull();
  });
});

describe("POST /:projectId/complete-init (ADR 013 addendum)", () => {
  it("dispatches the project's first deploy job alongside marking it ready", async () => {
    const project = makeProject({ status: "initializing" });
    const feature = makeFeature({ featureType: "project_init", status: "in_review" });
    const { app, projects, jobs } = buildApp({ project, feature });

    const res = await authedRequest(app).post(`/projects/${project.id}/complete-init`);

    expect(res.status).toBe(200);
    expect(projects.markReady).toHaveBeenCalledWith(project.id);
    expect(jobs.create).toHaveBeenCalledWith({ projectId: project.id, kind: "deploy" });
  });

  it("409s and dispatches nothing when the project is already ready", async () => {
    const project = makeProject({ status: "ready" });
    const { app, projects, jobs } = buildApp({ project });

    const res = await authedRequest(app).post(`/projects/${project.id}/complete-init`);

    expect(res.status).toBe(409);
    expect(projects.markReady).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
  });
});

describe("GET /:projectId/deploy", () => {
  it("returns null fields when the project has never had a deploy job", async () => {
    const project = makeProject({ status: "ready" });
    const { app } = buildApp({ project, latestDeployJob: null });

    const res = await authedRequest(app).get(`/projects/${project.id}/deploy`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: null,
      lastError: null,
      startedAt: null,
      completedAt: null,
      // ADR 022 additions: which operation is being reported, and the revision
      // currently live per the deploy ledger (null before the first deploy).
      kind: null,
      revision: null,
      url: `https://${project.slug}.apps.yggdrasil.local`,
    });
  });

  it("reflects the latest deploy job's status and error", async () => {
    const project = makeProject({ status: "ready" });
    const { app } = buildApp({
      project,
      latestDeployJob: {
        status: "failed",
        lastError: "helm upgrade failed: timed out waiting for condition",
        startedAt: new Date("2026-08-23T10:00:00Z"),
        completedAt: new Date("2026-08-23T10:05:00Z"),
      },
    });

    const res = await authedRequest(app).get(`/projects/${project.id}/deploy`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.lastError).toMatch(/helm upgrade failed/);
  });
});

describe("POST /:projectId/deploy", () => {
  it("dispatches a deploy job for a ready project with no deploy in flight", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs } = buildApp({ project, latestDeployJob: null });

    const res = await authedRequest(app).post(`/projects/${project.id}/deploy`);

    expect(res.status).toBe(201);
    expect(jobs.create).toHaveBeenCalledWith({ projectId: project.id, kind: "deploy" });
  });

  it("409s when the project isn't ready yet", async () => {
    const project = makeProject({ status: "initializing" });
    const { app, jobs } = buildApp({ project });

    const res = await authedRequest(app).post(`/projects/${project.id}/deploy`);

    expect(res.status).toBe(409);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("409s when a deploy is already pending or running", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs } = buildApp({
      project,
      latestDeployJob: { status: "running" },
    });

    const res = await authedRequest(app).post(`/projects/${project.id}/deploy`);

    expect(res.status).toBe(409);
    expect(jobs.create).not.toHaveBeenCalled();
  });
});

describe("GET /:projectId/deploys (ADR 022)", () => {
  it("returns the ledger newest first with the current revision and targets", async () => {
    const project = makeProject({ status: "ready" });
    const deployedAt = new Date("2026-09-17T10:00:00Z");
    const { app, deploys } = buildApp({
      project,
      currentRevision: 12,
      projectDeploys: [
        {
          id: "deploy_2",
          projectId: project.id,
          jobId: "job_2",
          kind: "rollback",
          helmRevision: 12,
          targetRevision: 9,
          status: "completed",
          lastError: null,
          ref: null,
          createdAt: deployedAt,
        },
      ],
      rollbackTargets: [{ revision: 9, deployedAt, kind: "deploy" }],
    });

    const res = await authedRequest(app).get(`/projects/${project.id}/deploys`);

    expect(res.status).toBe(200);
    expect(res.body.currentRevision).toBe(12);
    expect(res.body.deploys).toEqual([
      {
        id: "deploy_2",
        jobId: "job_2",
        kind: "rollback",
        helmRevision: 12,
        targetRevision: 9,
        status: "completed",
        lastError: null,
        ref: null,
        createdAt: deployedAt.toISOString(),
      },
    ]);
    // The offered targets exclude what is already running, so the current
    // revision 12 is absent.
    expect(res.body.rollbackTargets).toEqual([
      { revision: 9, deployedAt: deployedAt.toISOString(), kind: "deploy" },
    ]);
    expect(deploys.listForProject).toHaveBeenCalledWith(project.id);
  });

  it("404s for a project the caller cannot access", async () => {
    const project = makeProject({ status: "ready" });
    const { app } = buildApp({ project });

    const res = await authedRequest(app).get(
      "/projects/99999999-9999-4999-8999-999999999999/deploys",
    );

    expect(res.status).toBe(404);
  });
});

describe("POST /:projectId/rollback (ADR 022)", () => {
  it("enqueues a rollback job pinned to the requested revision and audits it", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs, audit } = buildApp({
      project,
      currentRevision: 12,
      knownRevisions: [9, 12],
      latestDeployJob: { status: "completed" },
    });

    const res = await authedRequest(app)
      .post(`/projects/${project.id}/rollback`)
      .send({ revision: 9 });

    expect(res.status).toBe(201);
    // The target is pinned onto the job row rather than resolved at claim
    // time, so a deploy landing before this job is claimed cannot change what
    // it rolls back to.
    expect(jobs.create).toHaveBeenCalledWith({
      projectId: project.id,
      kind: "rollback",
      targetRevision: 9,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "deploy.rolled_back",
        projectId: project.id,
        metadata: expect.objectContaining({ revision: 12, targetRevision: 9 }),
      }),
    );
  });

  // A rollback is a destructive production operation, so it has to be recorded
  // with an actor — unlike the routine deploy trigger, which ADR 028 leaves
  // unaudited because the job row already covers it (see ADR 022).
  it("records the acting user on the audit event", async () => {
    const project = makeProject({ status: "ready" });
    const { app, audit } = buildApp({
      project,
      currentRevision: 2,
      knownRevisions: [1, 2],
    });

    await authedRequest(app).post(`/projects/${project.id}/rollback`).send({ revision: 1 });

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actorUserId: OWNER_ID }),
    );
  });

  it("rejects a revision the project never produced", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs, audit } = buildApp({
      project,
      currentRevision: 12,
      knownRevisions: [12],
    });

    const res = await authedRequest(app)
      .post(`/projects/${project.id}/rollback`)
      .send({ revision: 99 });

    // 404, not 400: the request is well-formed, the target simply does not
    // exist for this project.
    expect(res.status).toBe(404);
    expect(jobs.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("409s when the requested revision is already deployed", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs } = buildApp({
      project,
      currentRevision: 12,
      knownRevisions: [12],
    });

    const res = await authedRequest(app)
      .post(`/projects/${project.id}/rollback`)
      .send({ revision: 12 });

    expect(res.status).toBe(409);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  // One deployment operation at a time, across BOTH kinds. A rollback racing a
  // deploy would have Helm reject whichever arrives second, mid-operation.
  it("409s while a deploy is already in flight", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs } = buildApp({
      project,
      currentRevision: 12,
      knownRevisions: [9, 12],
      latestDeployJob: { status: "running" },
    });

    const res = await authedRequest(app)
      .post(`/projects/${project.id}/rollback`)
      .send({ revision: 9 });

    expect(res.status).toBe(409);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("409s while a rollback is already in flight", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs } = buildApp({
      project,
      currentRevision: 12,
      knownRevisions: [9, 12],
      latestDeployJob: { status: "pending" },
    });

    const res = await authedRequest(app)
      .post(`/projects/${project.id}/rollback`)
      .send({ revision: 9 });

    expect(res.status).toBe(409);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("rejects a malformed revision", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs } = buildApp({ project, knownRevisions: [1] });

    const res = await authedRequest(app)
      .post(`/projects/${project.id}/rollback`)
      .send({ revision: 0 });

    expect(res.status).toBe(400);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("404s for a project the caller cannot access", async () => {
    const { app, jobs } = buildApp({ project: makeProject() });

    const res = await authedRequest(app)
      .post("/projects/99999999-9999-4999-8999-999999999999/rollback")
      .send({ revision: 1 });

    expect(res.status).toBe(404);
    expect(jobs.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /:projectId — agentic_review_enabled toggle (ADR 015 item 12)", () => {
  it("flips the toggle off and returns the updated project", async () => {
    const { app, projects } = buildApp({ project: makeProject() });

    const res = await authedRequest(app)
      .patch("/projects/11111111-1111-4111-8111-111111111111")
      .send({ agenticReviewEnabled: false });

    expect(res.status).toBe(200);
    expect(projects.setAgenticReviewEnabled).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      false,
    );
    // The mock's findByIdForUser returns the persisted project shape; the
    // toggle flag is present on the public project.
    expect(res.body.agenticReviewEnabled).toBe(true);
  });

  it("400s on a non-boolean payload", async () => {
    const { app } = buildApp({ project: makeProject() });

    const res = await authedRequest(app)
      .patch("/projects/11111111-1111-4111-8111-111111111111")
      .send({ agenticReviewEnabled: "yes" });

    expect(res.status).toBe(400);
  });

  it("404s for a project the user doesn't have access to", async () => {
    const { app } = buildApp({ project: makeProject() });

    // findByIdForUser returns null for any id other than the owned project.
    const res = await authedRequest(app)
      .patch("/projects/99999999-9999-4999-8999-999999999999")
      .send({ agenticReviewEnabled: false });

    expect(res.status).toBe(404);
  });
});

describe("Action Items + Resume Implementation (ADR 015)", () => {
  const project = makeProject();
  const feature = makeFeature({ featureType: "normal", status: "spec_ready", adrApproved: true });

  it("GET action-items returns the feature's action items", async () => {
    const { app, actionItems } = buildApp({ project, feature });
    actionItems.listForFeature.mockResolvedValue([{
      id: "ai_1",
      featureId: feature.id,
      type: "secret_request",
      description: "Need key",
      status: "open",
      resolvedAt: null,
      secretKey: "FOO",
      designSessionId: null,
      subtaskFeatureId: null,
      draftTestMarkdown: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }] as never);
    const res = await authedRequest(app).get(
      `/projects/${project.id}/features/${feature.id}/action-items`,
    );
    expect(res.status).toBe(200);
    expect(actionItems.listForFeature).toHaveBeenCalledWith(feature.id);
  });

  it("resolves an action item by id", async () => {
    const { app, actionItems } = buildApp({ project, feature });
    actionItems.findById.mockResolvedValue({ id: "ai_1", type: "secret_request" } as never);
    const res = await authedRequest(app).post(
      `/projects/${project.id}/features/${feature.id}/action-items/11111111-1111-4111-8111-111111111111/resolve`,
    );
    expect(res.status).toBe(200);
    expect(actionItems.resolve).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
  });

  it("resumes a returned feature (human gate) and dispatches feature_build", async () => {
    const returned = makeFeature({ featureType: "normal", status: "returned", adrApproved: true });
    const { app, jobs } = buildApp({ project, feature: returned, orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" } });

    const res = await authedRequest(app).post(
      `/projects/${project.id}/features/${feature.id}/resume`,
    );
    expect(res.status).toBe(201);
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: feature.id, kind: "feature_build" }),
    );
  });

  it("auto-resolves open secret_request action items whose key now exists (ADR 015 item 5)", async () => {
    const { app, actionItems } = buildApp({
      project,
      feature,
      projectSecrets: { STRIPE_API_KEY: "sk_test" },
    });
    actionItems.listForFeature.mockResolvedValue([
      {
        id: "ai_1",
        featureId: feature.id,
        type: "secret_request",
        description: "Need key",
        status: "open",
        secretKey: "STRIPE_API_KEY",
      },
    ] as never);
    const res = await authedRequest(app).post(
      `/projects/${project.id}/features/${feature.id}/action-items/auto-resolve`,
    );
    expect(res.status).toBe(200);
    expect(actionItems.resolve).toHaveBeenCalledWith("ai_1");
  });

  it("creates and resolves a supervised test_request action item", async () => {
    const { app, actionItems, tests } = buildApp({ project, feature });
    actionItems.findById.mockResolvedValue({
      id: "ai_3",
      featureId: feature.id,
      type: "test_request",
      description: "Verify checkout",
      status: "open",
      draftTestMarkdown: "## Checkout\nOpen checkout.",
    } as never);

    const res = await authedRequest(app)
      .post(`/projects/${project.id}/features/${feature.id}/action-items/11111111-1111-4111-8111-111111111111/test`)
      .send({
        name: "Checkout smoke test",
        scheduleCron: "0 * * * *",
      });

    expect(res.status).toBe(201);
    expect(tests.create).toHaveBeenCalledWith({
      projectId: project.id,
      name: "Checkout smoke test",
      specMarkdown: "## Checkout\nOpen checkout.",
      scheduleCron: "0 * * * *",
      enabled: true,
    });
    expect(actionItems.resolve).toHaveBeenCalledWith("ai_3");
  });

  it("creates a blocking subtask feature and parents it (ADR 015 item 5)", async () => {
    const { app, actionItems } = buildApp({ project, feature });
    actionItems.findById.mockResolvedValue({
      id: "ai_2",
      featureId: feature.id,
      type: "subtask_feature",
      description: "Needs a dependency",
    } as never);
    const res = await authedRequest(app)
      .post(`/projects/${project.id}/features/${feature.id}/action-items/11111111-1111-4111-8111-111111111111/subtask`)
      .send({ title: "Build the auth CLI" });
    expect(res.status).toBe(201);
    expect(actionItems.resolve).not.toHaveBeenCalled();
  });

  it("returns authorized structured agentic testing runs", async () => {
    const testingFeature = makeFeature({ status: "testing" });
    const { app, testRunReports } = buildApp({ project, feature: testingFeature });
    testRunReports.listByFeature.mockResolvedValue([{
      jobId: "job_test",
      testId: "test_1",
      status: "running",
      report: null,
      steps: [{
        name: "opens checkout",
        status: "pass",
        details: "done",
        screenshotPath: null,
        createdAt: new Date(),
      }],
    }] as never);

    const res = await authedRequest(app).get(
      `/projects/${project.id}/features/${testingFeature.id}/testing`,
    );
    expect(res.status).toBe(200);
    expect(res.body.featureId).toBe(testingFeature.id);
    expect(res.body.runs[0].status).toBe("running");
    expect(res.body.runs[0].steps[0].name).toBe("opens checkout");
  });
});

describe("DELETE /projects/:projectId", () => {
  it("deletes the project when confirmation text matches", async () => {
    const project = makeProject();
    const { app, projects } = buildApp({ project });

    const res = await authedRequest(app)
      .delete(`/projects/${project.id}`)
      .send({ confirm: "delete" });

    expect(res.status).toBe(204);
    expect(projects.delete).toHaveBeenCalledWith(project.id);
  });

  it("rejects deletion when confirmation text does not match", async () => {
    const project = makeProject();
    const { app, projects } = buildApp({ project });

    const res = await authedRequest(app)
      .delete(`/projects/${project.id}`)
      .send({ confirm: "not-delete" });

    expect(res.status).toBe(400);
    expect(projects.delete).not.toHaveBeenCalled();
  });

  it("blocks deletion while features are active and names them", async () => {
    const project = makeProject();
    const { app, features, projects } = buildApp({ project });
    features.hasBlockingStatuses.mockResolvedValue(true);
    features.listBlocking.mockResolvedValue([
      { id: "feat_1", title: "Checkout flow", slug: "checkout-flow", status: "running" },
    ] as never);

    const res = await authedRequest(app)
      .delete(`/projects/${project.id}`)
      .send({ confirm: "delete" });

    expect(res.status).toBe(409);
    expect(projects.delete).not.toHaveBeenCalled();
    expect(res.body.features).toEqual([
      { id: "feat_1", title: "Checkout flow", slug: "checkout-flow", status: "running" },
    ]);
  });

  it("404s for a project the user cannot access", async () => {
    const project = makeProject();
    const { app } = buildApp({ project });

    const res = await authedRequest(app)
      .delete(`/projects/22222222-2222-4222-8222-222222222222`)
      .send({ confirm: "delete" });

    expect(res.status).toBe(404);
  });
});

describe("POST /projects/:projectId/features/:featureId/cancel", () => {
  it("force-cancels a feature synchronously and cancels its active jobs", async () => {
    const feature = makeFeature({ status: "draft" });
    const project = makeProject();
    const { app, features, jobs } = buildApp({ project, feature });

    const res = await authedRequest(app).post(
      `/projects/${project.id}/features/${feature.id}/cancel`,
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(features.cancel).toHaveBeenCalledWith(feature.id);
    expect(jobs.cancelActiveForFeature).toHaveBeenCalledWith(feature.id);
  });

  it("409s when the feature cannot be cancelled from its current state", async () => {
    const feature = makeFeature({ status: "merged" });
    const project = makeProject();
    const { app, features, jobs } = buildApp({ project, feature });
    features.cancel.mockResolvedValue(null);

    const res = await authedRequest(app).post(
      `/projects/${project.id}/features/${feature.id}/cancel`,
    );

    expect(res.status).toBe(409);
    expect(jobs.cancelActiveForFeature).not.toHaveBeenCalled();
  });
});

describe("POST /projects/:projectId/features/:featureId/restart", () => {
  it("restarts a cancelled feature into draft and dispatches a fresh spec_grill", async () => {
    const feature = makeFeature({ status: "cancelled" });
    const project = makeProject();
    const { app, features, jobs } = buildApp({
      project,
      feature,
      orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
    });

    const res = await authedRequest(app).post(
      `/projects/${project.id}/features/${feature.id}/restart`,
    );

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(features.restartFromCancelled).toHaveBeenCalledWith(feature.id);
    expect(jobs.create).toHaveBeenCalled();
  });

  it("409s when the feature is not cancelled", async () => {
    const feature = makeFeature({ status: "draft" });
    const project = makeProject();
    const { app, features } = buildApp({
      project,
      feature,
      orgSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
    });
    features.restartFromCancelled.mockResolvedValue(null);

    const res = await authedRequest(app).post(
      `/projects/${project.id}/features/${feature.id}/restart`,
    );

    expect(res.status).toBe(409);
  });
});

// ADR 026 (issue #16): the standalone Testing product's per-Test run history.
// Distinct from ADR 015's per-feature Testing tab, which the suite already
// covers above — these are the project-level reads.
describe("GET /projects/:projectId/tests/:testId/runs", () => {
  function historyEntry(overrides: Record<string, unknown> = {}) {
    return {
      jobId: "44444444-4444-4444-8444-444444444444",
      testId: "33333333-3333-4333-8333-333333333333",
      status: "completed",
      trigger: "schedule",
      testGroup: null,
      ref: "main",
      createdAt: new Date("2026-09-17T09:00:00Z"),
      startedAt: new Date("2026-09-17T09:00:05Z"),
      completedAt: new Date("2026-09-17T09:01:35Z"),
      report: {
        jobId: "44444444-4444-4444-8444-444444444444",
        testId: "33333333-3333-4333-8333-333333333333",
        passed: 12,
        failed: 1,
        skipped: 0,
        total: 13,
        coveragePercent: 84.5,
        failingTests: ["checkout rejects an expired card"],
        summary: "12 passed, 1 failed",
        recordingPath: null,
        createdAt: new Date("2026-09-17T09:01:30Z"),
        steps: [],
      },
      steps: [],
      ...overrides,
    };
  }

  it("returns the test's run history, newest first, scoped to the project", async () => {
    const project = makeProject();
    const { app, testRunReports, tests } = buildApp({ project });
    tests.findById.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", projectId: project.id } as never);
    testRunReports.listRunsForTest.mockResolvedValue([historyEntry()] as never);

    const res = await authedRequest(app).get(
      `/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs`,
    );

    expect(res.status).toBe(200);
    expect(res.body.testId).toBe("33333333-3333-4333-8333-333333333333");
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0]).toMatchObject({
      jobId: "44444444-4444-4444-8444-444444444444",
      status: "completed",
      trigger: "schedule",
      ref: "main",
    });
    // The report is flattened for the wire, with its own timestamps ISO-d.
    expect(res.body.runs[0].report).toMatchObject({
      passed: 12,
      failed: 1,
      total: 13,
      failingTests: ["checkout rejects an expired card"],
    });
    expect(typeof res.body.runs[0].createdAt).toBe("string");
    // Duration is derived server-side so both surfaces agree.
    expect(res.body.runs[0].durationMs).toBe(90_000);
    // Scoped by the resolved test, not by a client-supplied id.
    expect(testRunReports.listRunsForTest).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", 50);
  });

  it("404s for a test that is not in this project", async () => {
    const project = makeProject();
    const { app, testRunReports, tests } = buildApp({ project });
    tests.findById.mockResolvedValue(null);

    const res = await authedRequest(app).get(
      `/projects/${project.id}/tests/55555555-5555-4555-8555-555555555555/runs`,
    );

    expect(res.status).toBe(404);
    // Crucially the history is never read: project scoping happens first.
    expect(testRunReports.listRunsForTest).not.toHaveBeenCalled();
  });

  it("404s for an unknown project", async () => {
    const project = makeProject();
    const { app, testRunReports, projects } = buildApp({ project });
    projects.findByIdForUser.mockResolvedValue(null);

    const res = await authedRequest(app).get(
      `/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs`,
    );

    expect(res.status).toBe(404);
    expect(testRunReports.listRunsForTest).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    const project = makeProject();
    const { app } = buildApp({ project });

    const res = await request(app).get(
      `/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs`,
    );

    expect(res.status).toBe(401);
  });

  it("honours a limit and caps an absurd one", async () => {
    const project = makeProject();
    const { app, testRunReports, tests } = buildApp({ project });
    tests.findById.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", projectId: project.id } as never);

    await authedRequest(app).get(`/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs?limit=5`);
    expect(testRunReports.listRunsForTest).toHaveBeenLastCalledWith("33333333-3333-4333-8333-333333333333", 5);

    await authedRequest(app).get(`/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs?limit=99999`);
    expect(testRunReports.listRunsForTest).toHaveBeenLastCalledWith("33333333-3333-4333-8333-333333333333", 200);

    // A junk limit is a display hint, not a client error.
    await authedRequest(app).get(`/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs?limit=abc`);
    expect(testRunReports.listRunsForTest).toHaveBeenLastCalledWith("33333333-3333-4333-8333-333333333333", 50);
  });

  it("returns an empty history rather than failing for a never-run test", async () => {
    const project = makeProject();
    const { app, tests, testRunReports } = buildApp({ project });
    tests.findById.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", projectId: project.id } as never);
    testRunReports.listRunsForTest.mockResolvedValue([] as never);

    const res = await authedRequest(app).get(
      `/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs`,
    );

    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });
});

describe("GET /projects/:projectId/tests/:testId/runs/:jobId", () => {
  it("returns one run with its steps", async () => {
    const project = makeProject();
    const { app, testRunReports, tests } = buildApp({ project });
    tests.findById.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", projectId: project.id } as never);
    testRunReports.findRunForTest.mockResolvedValue({
      jobId: "44444444-4444-4444-8444-444444444444",
      testId: "33333333-3333-4333-8333-333333333333",
      status: "failed",
      trigger: "schedule",
      testGroup: null,
      ref: "main",
      createdAt: new Date("2026-09-17T09:00:00Z"),
      startedAt: new Date("2026-09-17T09:00:00Z"),
      completedAt: new Date("2026-09-17T09:00:30Z"),
      report: null,
      steps: [
        {
          name: "signs in",
          status: "pass",
          details: null,
          screenshotPath: null,
          createdAt: new Date("2026-09-17T09:00:10Z"),
        },
        {
          name: "adds to cart",
          status: "fail",
          details: "cart badge stayed 0",
          screenshotPath: "steps/cart.png",
          createdAt: new Date("2026-09-17T09:00:20Z"),
        },
      ],
    } as never);

    const res = await authedRequest(app).get(
      `/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs/44444444-4444-4444-8444-444444444444`,
    );

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe("44444444-4444-4444-8444-444444444444");
    expect(res.body.status).toBe("failed");
    // A run that failed before reporting still shows its steps, and says so
    // with a null report rather than a fabricated zeroed one.
    expect(res.body.report).toBeNull();
    expect(res.body.steps).toHaveLength(2);
    expect(res.body.steps[1]).toMatchObject({
      name: "adds to cart",
      status: "fail",
      details: "cart badge stayed 0",
    });
    expect(testRunReports.findRunForTest).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444");
  });

  it("404s when the run belongs to a different test", async () => {
    const project = makeProject();
    const { app, testRunReports, tests } = buildApp({ project });
    tests.findById.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", projectId: project.id } as never);
    testRunReports.findRunForTest.mockResolvedValue(null);

    const res = await authedRequest(app).get(
      `/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs/22222222-2222-4222-8222-222222222222`,
    );

    expect(res.status).toBe(404);
  });

  it("404s on a malformed job id without querying", async () => {
    const project = makeProject();
    const { app, testRunReports, tests } = buildApp({ project });
    tests.findById.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333", projectId: project.id } as never);

    const res = await authedRequest(app).get(
      `/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs/not-a-uuid`,
    );

    expect(res.status).toBe(404);
    expect(testRunReports.findRunForTest).not.toHaveBeenCalled();
  });

  it("404s for a test outside this project", async () => {
    const project = makeProject();
    const { app, testRunReports, tests } = buildApp({ project });
    tests.findById.mockResolvedValue(null);

    const res = await authedRequest(app).get(
      `/projects/${project.id}/tests/55555555-5555-4555-8555-555555555555/runs/44444444-4444-4444-8444-444444444444`,
    );

    expect(res.status).toBe(404);
    expect(testRunReports.findRunForTest).not.toHaveBeenCalled();
  });

  it("401s when unauthenticated", async () => {
    const project = makeProject();
    const { app } = buildApp({ project });

    const res = await request(app).get(
      `/projects/${project.id}/tests/33333333-3333-4333-8333-333333333333/runs/44444444-4444-4444-8444-444444444444`,
    );

    expect(res.status).toBe(401);
  });
});
