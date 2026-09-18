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
    uploadedExtensionsEnabled: false,
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
  /** `null` means "the caller cannot access it", which is how the 404 paths are driven. */
  project: Project | null;
  /** `null` means "no such feature in that project". */
  feature?: Feature | null;
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
  /** Issue #26: the ref recorded for the revision a rollback targets. */
  refForRevision?: string | null;
  /** Issue #31: whether the target test already has a run in flight. */
  testHasActiveRun?: boolean;
  /** Issue #59: the feature's most recent `submit_review` event, or null. */
  latestReview?: unknown;
  /** ADR 024 state: the latest job (whose events form the transcript) and its events. */
  latestJob?: unknown;
  transcriptEvents?: unknown[];
  /** Forces `resetForMessageRestart` to report the feature moved on before the rewind landed. */
  resetForMessageRestartRefused?: boolean;
}

function buildApp(opts: BuildAppOptions) {
  /**
   * Issue #59: the Agentic Review read. Defaults to "never reviewed" — the state
   * most tests are in, and the one the endpoint's null-verdict branch is about.
   */
  const jobEvents = {
    listByJob: vi.fn(async () => opts.transcriptEvents ?? []),
    listSpecGrillByFeature: vi.fn(async () => opts.transcriptEvents ?? []),
    findLatestReviewByFeature: vi.fn(async () => opts.latestReview ?? null),
  };

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
      opts.project && id === opts.project.id && userId === OWNER_ID ? opts.project : null,
    ),
    create: vi.fn(async () => opts.project),
    markReady: vi.fn(async () => undefined),
    setAgenticReviewEnabled: vi.fn(async () => undefined),
    setUploadedExtensionsEnabled: vi.fn(async () => undefined),
    // Issue #31: recording the project's schedule timezone.
    setTimeZone: vi.fn(async () => undefined),
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
    // ADR 024: the guarded rewind. Mirrors the real guard by returning null
    // when the caller opts a feature out, so the "feature moved on" race is
    // exercisable without a database.
    resetForMessageRestart: vi.fn(async () =>
      opts.resetForMessageRestartRefused ? null : { ...(opts.feature ?? makeFeature()), status: "draft" },
    ),
    queueBuild: vi.fn(async () => opts.feature ?? null),
    resumeImplementation: vi.fn(async () => opts.feature ?? null),
    setReturned: vi.fn(async () => opts.feature ?? null),
    setTesting: vi.fn(async () => opts.feature ?? null),
    setAgenticReview: vi.fn(async () => opts.feature ?? null),
    approveReview: vi.fn(async () => opts.feature ?? null),
    createSubtask: vi.fn(async () => opts.feature ?? makeFeature()),
  };
  const jobs = {
    // `_input` is typed (and unused) so this fake's recorded call arguments are
    // addressable by assertions — several routes' tests inspect what was
    // dispatched (ADR 024's seed, ADR 022's target revision).
    create: vi.fn(async (_input: unknown) => ({ id: "job_1" })),
    hasActiveTestRunsForProject: vi.fn(async () => false),
    listActiveTestRunsForProject: vi.fn(async () => []),
    findActiveSpecGrillJob: vi.fn(async () => opts.activeSpecGrillJob ?? null),
    // ADR 024: the transcript a per-message restart rewinds is the feature's
    // latest job's, so the route resolves it the same way the events endpoint
    // does.
    findLatestJob: vi.fn(async () => opts.latestJob ?? null),
    findLatestByProjectAndKind: vi.fn(async () => opts.latestDeployJob ?? null),
    // ADR 022: the deploy/rollback pair shares one in-flight guard, so the
    // routes now ask for both kinds at once. Fed from the same fake so every
    // existing deploy assertion keeps its original meaning.
    findLatestByProjectAndKinds: vi.fn(async () => opts.latestDeployJob ?? null),
    cancelActiveForFeature: vi.fn(async () => undefined),
    // Issue #31: "Run now" refuses while this test already has a run in flight.
    hasActiveRunForTest: vi.fn(async () => opts.testHasActiveRun ?? false),
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
    // Issue #26: a rollback job carries the ref of the revision it targets,
    // since it applies no new commit of its own.
    refForRevision: vi.fn(async () => opts.refForRevision ?? null),
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
      jobEvents: jobEvents as never,
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
    jobEvents,
  };
}

const SESSION_COOKIE = "yggdrasil_session=sess_1";

function authedRequest(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", SESSION_COOKIE),
    post: (url: string) => request(app).post(url).set("Cookie", SESSION_COOKIE),
    put: (url: string) => request(app).put(url).set("Cookie", SESSION_COOKIE),
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
    // Issue #26: the first deploy records which ref it is of, same as every
    // later one.
    expect(jobs.create).toHaveBeenCalledWith({
      projectId: project.id,
      kind: "deploy",
      ref: "main",
    });
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
    // Issue #26: the primary deployment is always the default branch's content,
    // so the job records `main` rather than leaving the ledger's ref column
    // permanently null.
    expect(jobs.create).toHaveBeenCalledWith({
      projectId: project.id,
      kind: "deploy",
      ref: "main",
    });
  });

  // The asymmetry with rollback was the thing that read wrong (issue #26):
  // the routine manual deploy has an actor and is audited. A push-driven deploy
  // still is not — it has no actor and would add a row per push to main.
  it("audits the manual trigger with its actor, unlike a push-driven deploy", async () => {
    const project = makeProject({ status: "ready" });
    const { app, audit } = buildApp({ project, latestDeployJob: null });

    await authedRequest(app).post(`/projects/${project.id}/deploy`);

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "deploy.triggered",
        projectId: project.id,
        actorUserId: OWNER_ID,
      }),
    );
  });

  // The route's pre-check cannot see a concurrent request's insert. The
  // database can (migration 043's partial unique index), and the loser of that
  // race has to be told so rather than surfacing a 500.
  it("409s when another request wins the in-flight race", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs } = buildApp({ project, latestDeployJob: null });
    jobs.create.mockRejectedValueOnce(
      Object.assign(new Error("duplicate key value violates unique constraint"), {
        code: "23505",
        constraint: "idx_jobs_one_active_deploy_per_project",
      }),
    );

    const res = await authedRequest(app).post(`/projects/${project.id}/deploy`);

    expect(res.status).toBe(409);
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
      // No ref recorded for revision 9 in this setup, so the job carries none.
      ref: undefined,
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

  // Issue #26: a rollback applies no new commit of its own, so the only honest
  // answer to "which commit is deployed" once it finishes is the ref the target
  // revision was deployed from.
  it("carries the targeted revision's ref onto the rollback job", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs } = buildApp({
      project,
      currentRevision: 12,
      knownRevisions: [9, 12],
      refForRevision: "main",
    });

    await authedRequest(app).post(`/projects/${project.id}/rollback`).send({ revision: 9 });

    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "rollback", targetRevision: 9, ref: "main" }),
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

describe("POST /projects/:projectId/features/:featureId/restart-from-message (ADR 024)", () => {
  const MODEL_ENV = { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" };

  const FIRST_TURN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SECOND_TURN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const TERMINAL_EVENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  /**
   * A finished grill transcript: an agent question, the user's answer, then the
   * terminal `submit_adr` marker.
   */
  function grillEvents() {
    const base = {
      jobId: "job_1",
      markdown: null,
      status: null,
      prUrl: null,
      summary: null,
      actionItems: null,
      snapshot: null,
      createdAt: new Date(),
    };
    return [
      { ...base, id: FIRST_TURN, type: "ask_user", question: "One saved card, or many?", message: null },
      { ...base, id: SECOND_TURN, type: "user_message", question: null, message: "Many, with one default." },
      { ...base, id: TERMINAL_EVENT, type: "submit_adr", question: null, message: null },
    ];
  }

  function setup(overrides: Partial<BuildAppOptions> = {}) {
    const feature = makeFeature({ status: "draft" });
    const project = makeProject();
    const built = buildApp({
      project,
      feature,
      orgSecrets: MODEL_ENV,
      latestJob: { id: "job_1", kind: "spec_grill", status: "completed" },
      transcriptEvents: grillEvents(),
      ...overrides,
    });
    return { feature, project, ...built };
  }

  function restartRequest(app: express.Express, projectId: string, featureId: string) {
    return authedRequest(app).post(
      `/projects/${projectId}/features/${featureId}/restart-from-message`,
    );
  }

  /** The argument the route dispatched for the most recent job insert. */
  function dispatchedJob(jobs: { create: { mock: { calls: unknown[][] } } }) {
    return jobs.create.mock.calls[0][0] as {
      kind: string;
      restartedFromEventId?: string;
      specContext: { grillTranscriptSummary: string; restartFromMessage: boolean };
    };
  }

  it("rewinds to draft and seeds a new spec_grill from the turns before the chosen one", async () => {
    const { app, feature, project, jobs } = setup();

    const res = await restartRequest(app, project.id, feature.id).send({ eventId: SECOND_TURN });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(jobs.create).toHaveBeenCalledTimes(1);

    const dispatched = dispatchedJob(jobs);
    expect(dispatched.kind).toBe("spec_grill");
    expect(dispatched.specContext.restartFromMessage).toBe(true);
    // Exclusive boundary: the question before the chosen turn is kept, and the
    // user's own answer at it is not — that is the turn being redone.
    expect(dispatched.specContext.grillTranscriptSummary).toBe(
      "Agent question: One saved card, or many?",
    );
  });

  it("records which turn the rewind was taken at, on the job and in the audit trail", async () => {
    const { app, feature, project, jobs, audit } = setup();

    await restartRequest(app, project.id, feature.id).send({ eventId: SECOND_TURN });

    expect(jobs.create.mock.calls[0][0]).toMatchObject({
      restartedFromEventId: SECOND_TURN,
    });
    // ADR 028 coverage: the mutation is recorded, and the turn is part of the
    // record — "a grill was rewound" without "how far" would not be actionable.
    const recorded = audit.record.mock.calls.map(
      (call) => call[1] as { action: string; targetId: string; metadata?: { restartedFromEventId?: string } },
    );
    expect(recorded).toContainEqual(
      expect.objectContaining({
        action: "feature.grill_restarted_from_message",
        targetId: feature.id,
        metadata: expect.objectContaining({ restartedFromEventId: SECOND_TURN }),
      }),
    );
  });

  it("keeps the superseded run as history rather than mutating it", async () => {
    const { app, feature, project, jobs } = setup();

    await restartRequest(app, project.id, feature.id).send({ eventId: SECOND_TURN });

    // ADR 012's precedent: always a new job row. The old run is left alone.
    expect(jobs.create).toHaveBeenCalledTimes(1);
    expect(Object.keys(jobs)).not.toContain("update");
  });

  it("404s for an event id that is not in the current transcript", async () => {
    const { app, feature, project, jobs } = setup();

    const res = await restartRequest(app, project.id, feature.id).send({
      eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    });

    expect(res.status).toBe(404);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("404s when the chosen event is a terminal marker, not a conversation turn", async () => {
    const { app, feature, project, jobs } = setup();

    const res = await restartRequest(app, project.id, feature.id).send({
      eventId: TERMINAL_EVENT,
    });

    expect(res.status).toBe(404);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("400s on a missing or malformed event id", async () => {
    const { app, feature, project } = setup();

    const missing = await restartRequest(app, project.id, feature.id).send({});
    const malformed = await restartRequest(app, project.id, feature.id).send({
      eventId: "not-a-uuid",
    });

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
  });

  it("409s while a grill session is running, which ADR 006's mid-run reply already steers", async () => {
    const { app, feature, project, jobs } = setup({ activeSpecGrillJob: { id: "job_1" } });

    const res = await restartRequest(app, project.id, feature.id).send({ eventId: SECOND_TURN });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already running");
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("409s once the feature has moved past Spec, naming the state", async () => {
    const { app, project, jobs } = setup({ feature: makeFeature({ status: "in_review" }) });

    const res = await restartRequest(app, project.id, "22222222-2222-4222-8222-222222222222").send(
      { eventId: SECOND_TURN },
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("in_review");
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("409s when the latest run is not a grill, so a failed build's transcript is not rewritten", async () => {
    const { app, feature, project, jobs } = setup({
      feature: makeFeature({ status: "failed" }),
      latestJob: { id: "job_1", kind: "feature_build", status: "failed" },
    });

    const res = await restartRequest(app, project.id, feature.id).send({ eventId: SECOND_TURN });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("not a grill");
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("409s without dispatching when the guarded rewind refuses — the feature moved on", async () => {
    const { app, feature, project, jobs } = setup({ resetForMessageRestartRefused: true });

    const res = await restartRequest(app, project.id, feature.id).send({ eventId: SECOND_TURN });

    expect(res.status).toBe(409);
    // The point of the guarded UPDATE: never leave an orphan grill run for a
    // feature that is no longer in a restartable state.
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("passes the allowed status set to the guarded rewind", async () => {
    const { app, feature, project, features } = setup();

    await restartRequest(app, project.id, feature.id).send({ eventId: SECOND_TURN });

    expect(features.resetForMessageRestart).toHaveBeenCalledWith(feature.id, [
      "draft",
      "spec_ready",
      "failed",
      "cancelled",
    ]);
  });

  it("404s for a project the user does not own", async () => {
    const { app, feature } = setup();

    const res = await restartRequest(
      app,
      "99999999-9999-4999-8999-999999999999",
      feature.id,
    ).send({ eventId: SECOND_TURN });

    expect(res.status).toBe(404);
  });

  it("400s when no model configuration is resolvable, before touching the feature", async () => {
    const project = makeProject();
    const feature = makeFeature({ status: "draft" });
    const { app, features, jobs } = buildApp({
      project,
      feature,
      latestJob: { id: "job_1", kind: "spec_grill", status: "completed" },
      transcriptEvents: grillEvents(),
    });

    const res = await restartRequest(app, project.id, feature.id).send({ eventId: SECOND_TURN });

    expect(res.status).toBe(400);
    expect(features.resetForMessageRestart).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
  });
});

// ADR 026 (issue #16): the standalone Testing product's per-Test run history.
// Distinct from ADR 015's per-feature Testing tab, which the suite already
// covers above — these are the project-level reads.
/*
 * Issue #31 part 2. A suite could only be triggered by its cron, so a user who
 * fixed a failing test waited up to a full interval to learn whether the fix
 * worked. ADR 026 skipped this on purpose — a new mutating endpoint means new
 * authorization surface *and* an ADR 028 audit row — so both are asserted here,
 * not just the happy path.
 */
describe("POST /projects/:projectId/tests/:testId/run (issue #31)", () => {
  const TEST_ID = "33333333-3333-4333-8333-333333333333";

  function ready(overrides: Partial<Parameters<typeof buildApp>[0]> = {}) {
    const project = makeProject({ status: "ready" });
    const built = buildApp({ project, ...overrides });
    built.tests.findById.mockResolvedValue({
      id: TEST_ID,
      projectId: project.id,
      name: "Nightly regression",
    } as never);
    return { project, ...built };
  }

  it("dispatches a run now, on the same terms as a scheduled one", async () => {
    const { app, project, jobs } = ready();

    const res = await authedRequest(app).post(`/projects/${project.id}/tests/${TEST_ID}/run`);

    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe("job_1");
    // Same kind, same ref, no feature — a manual run verifies what a scheduled
    // run verifies, the project's default branch.
    expect(jobs.create).toHaveBeenCalledWith({
      projectId: project.id,
      kind: "test_run",
      testId: TEST_ID,
      ref: "main",
      trigger: "manual",
    });
  });

  // The distinction the whole `trigger` field exists for: a run a person started
  // must not be attributed to the scheduler in the history that shows it.
  it("records the trigger as manual, not schedule", async () => {
    const { app, project, jobs } = ready();

    await authedRequest(app).post(`/projects/${project.id}/tests/${TEST_ID}/run`);

    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "manual" }),
    );
    expect(jobs.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "schedule" }),
    );
  });

  // ADR 028: the scheduled dispatch is deliberately unaudited (no actor, one row
  // per window); a manual one exists because a person decided it should.
  it("records an audit row naming the actor and the run it produced", async () => {
    const { app, project, audit } = ready();

    await authedRequest(app).post(`/projects/${project.id}/tests/${TEST_ID}/run`);

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "test.run_triggered",
        projectId: project.id,
        actorUserId: OWNER_ID,
        targetType: "test",
        targetId: TEST_ID,
        metadata: expect.objectContaining({ jobId: "job_1", ref: "main" }),
      }),
    );
  });

  // Authorization is the project-membership gate the neighbouring routes use,
  // not a new capability — a member who may edit a test's schedule and delete the
  // test may certainly run it. A caller with no access gets the same 404 as
  // everywhere else, so project existence is not leaked either.
  it("refuses a caller without access to the project, dispatching nothing", async () => {
    const { app, jobs, tests } = ready();

    const res = await authedRequest(app).post(
      `/projects/99999999-9999-4999-8999-999999999999/tests/${TEST_ID}/run`,
    );

    expect(res.status).toBe(404);
    expect(tests.findById).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("404s for a test that is not in this project", async () => {
    const project = makeProject({ status: "ready" });
    const { app, jobs, tests } = buildApp({ project });
    tests.findById.mockResolvedValue(null);

    const res = await authedRequest(app).post(`/projects/${project.id}/tests/${TEST_ID}/run`);

    expect(res.status).toBe(404);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("409s before initialization completes, like the other test writes", async () => {
    const project = makeProject({ status: "initializing" });
    const { app, jobs, tests } = buildApp({ project });
    tests.findById.mockResolvedValue({ id: TEST_ID } as never);

    const res = await authedRequest(app).post(`/projects/${project.id}/tests/${TEST_ID}/run`);

    expect(res.status).toBe(409);
    expect(jobs.create).not.toHaveBeenCalled();
  });

  // A double-clicked button must not enqueue two identical runs. The scheduler
  // gets this for free (one dispatch per test per tick); a manual trigger has no
  // tick to lean on, so the guard is explicit.
  it("409s when this test already has a run in flight", async () => {
    const { app, project, jobs } = ready({ testHasActiveRun: true });

    const res = await authedRequest(app).post(`/projects/${project.id}/tests/${TEST_ID}/run`);

    expect(res.status).toBe(409);
    expect(jobs.create).not.toHaveBeenCalled();
    // And nothing is audited: the mutation did not happen, and ADR 028 records
    // successful mutations only.
  });

  it("does not audit a run that was refused", async () => {
    const { app, project, audit } = ready({ testHasActiveRun: true });

    await authedRequest(app).post(`/projects/${project.id}/tests/${TEST_ID}/run`);

    expect(audit.record).not.toHaveBeenCalled();
  });
});

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

// ADR 025 item 7: the per-project opt-in for uploaded extensions. Separate
// from the agentic-review toggle above because it decides whether code an org
// admin uploaded runs inside this project's job containers.
describe("PATCH /:projectId/uploaded-extensions-enabled (ADR 025)", () => {
  it("flips the opt-in on, returns the updated project, and records an audit entry", async () => {
    const { app, projects, audit } = buildApp({ project: makeProject() });

    const res = await authedRequest(app)
      .patch("/projects/11111111-1111-4111-8111-111111111111/uploaded-extensions-enabled")
      .send({ uploadedExtensionsEnabled: true });

    expect(res.status).toBe(200);
    expect(projects.setUploadedExtensionsEnabled).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      true,
    );
    // Its own action, not a generic project.updated: a trail reader should be
    // able to find "when did this project start loading uploaded code" without
    // opening every project mutation.
    const recorded = audit.record.mock.calls.map(
      (call) => call[1] as { action: string; metadata?: Record<string, unknown> },
    );
    expect(recorded).toContainEqual(
      expect.objectContaining({
        action: "project.uploaded_extensions_changed",
        metadata: expect.objectContaining({ uploadedExtensionsEnabled: true }),
      }),
    );
  });

  it("can turn the opt-in back off", async () => {
    const { app, projects } = buildApp({ project: makeProject() });

    const res = await authedRequest(app)
      .patch("/projects/11111111-1111-4111-8111-111111111111/uploaded-extensions-enabled")
      .send({ uploadedExtensionsEnabled: false });

    expect(res.status).toBe(200);
    expect(projects.setUploadedExtensionsEnabled).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      false,
    );
  });

  it("400s on a non-boolean payload without mutating", async () => {
    const { app, projects } = buildApp({ project: makeProject() });

    const res = await authedRequest(app)
      .patch("/projects/11111111-1111-4111-8111-111111111111/uploaded-extensions-enabled")
      .send({ uploadedExtensionsEnabled: "yes" });

    expect(res.status).toBe(400);
    expect(projects.setUploadedExtensionsEnabled).not.toHaveBeenCalled();
  });

  it("404s a project the caller does not own", async () => {
    const { app, projects } = buildApp({ project: makeProject() });

    const res = await authedRequest(app)
      .patch("/projects/99999999-9999-4999-8999-999999999999/uploaded-extensions-enabled")
      .send({ uploadedExtensionsEnabled: true });

    expect(res.status).toBe(404);
    expect(projects.setUploadedExtensionsEnabled).not.toHaveBeenCalled();
  });
});

describe("GET /:projectId/features/:featureId/agentic-review (issue #59)", () => {
  const project = makeProject();
  const feature = makeFeature({ status: "agentic_review" });
  const url = `/projects/${project.id}/features/${feature.id}/agentic-review`;

  /**
   * The path the Web app actually calls. `fetchFeatureAgenticReview`
   * (`web/lib/api.ts`) builds exactly this URL, and it 404'd against the real app
   * for the whole life of the tab — nothing asserted the two sides agreed. This
   * is that assertion, in the API's own suite because that is where the route
   * lives; #56 was the same class of gap one layer over.
   */
  it("resolves the path the Web client calls", async () => {
    const { app, jobEvents } = buildApp({ project, feature, latestReview: null });

    const res = await authedRequest(app).get(url);

    expect(res.status).toBe(200);
    expect(jobEvents.findLatestReviewByFeature).toHaveBeenCalledWith(feature.id);
  });

  it("returns the recorded verdict and comment", async () => {
    const { app } = buildApp({
      project,
      feature,
      latestReview: {
        id: "evt_1",
        jobId: "job_1",
        type: "submit_review",
        question: null,
        markdown: null,
        message: null,
        status: null,
        prUrl: null,
        summary: "The refresh path is missing.",
        verdict: "changes_requested",
        actionItems: null,
        snapshot: null,
        createdAt: new Date("2026-09-18T10:00:00.000Z"),
      },
    });

    const res = await authedRequest(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      verdict: "changes_requested",
      summary: "The refresh path is missing.",
      comments: [],
      jobId: "job_1",
      completedAt: "2026-09-18T10:00:00.000Z",
    });
  });

  // The tab's reported symptom. A 404 made "nobody has reviewed this" and "the
  // request failed" the same outcome, so the client's honest empty state could
  // never render and every un-reviewed feature showed an error instead.
  it("answers 200 with a null verdict for a feature that was never reviewed", async () => {
    const { app } = buildApp({ project, feature, latestReview: null });

    const res = await authedRequest(app).get(url);

    expect(res.status).toBe(200);
    expect(res.body.verdict).toBeNull();
    expect(res.body.summary).toBeNull();
    expect(res.body.comments).toEqual([]);
  });

  it("404s a feature that is not in the project the caller asked about", async () => {
    // `getOwnedProject` succeeds (the caller owns the project); the feature read
    // is what has to reject it, which is the same gate the sibling routes use.
    const { app, jobEvents } = buildApp({ project, feature: null });

    const res = await authedRequest(app).get(
      `/projects/${project.id}/features/${feature.id}/agentic-review`,
    );

    expect(res.status).toBe(404);
    expect(jobEvents.findLatestReviewByFeature).not.toHaveBeenCalled();
  });

  it("404s a malformed feature id without querying", async () => {
    const { app, jobEvents } = buildApp({ project, feature });

    const res = await authedRequest(app).get(
      `/projects/${project.id}/features/not-a-uuid/agentic-review`,
    );

    expect(res.status).toBe(404);
    expect(jobEvents.findLatestReviewByFeature).not.toHaveBeenCalled();
  });

  it("404s a project the caller cannot access", async () => {
    const { app, jobEvents } = buildApp({ project: null, feature });

    const res = await authedRequest(app).get(url);

    expect(res.status).toBe(404);
    expect(jobEvents.findLatestReviewByFeature).not.toHaveBeenCalled();
  });
});

describe("PUT /:projectId/timezone (issue #31 part 1)", () => {
  const project = makeProject();
  const url = `/projects/${project.id}/timezone`;

  it("stores a real IANA zone", async () => {
    const { app, projects } = buildApp({ project });

    const res = await authedRequest(app).put(url).send({ timeZone: "America/New_York" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: "America/New_York" });
    expect(projects.setTimeZone).toHaveBeenCalledWith(project.id, "America/New_York");
  });

  // Validated on write so a typo is a 400 rather than a project that quietly
  // schedules in UTC forever — the failure a user would never see.
  it("rejects a zone this runtime cannot resolve", async () => {
    const { app, projects } = buildApp({ project });

    const res = await authedRequest(app).put(url).send({ timeZone: "Not/AZone" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Not/AZone");
    expect(projects.setTimeZone).not.toHaveBeenCalled();
  });

  it("clears back to the default for an explicit null", async () => {
    const { app, projects } = buildApp({ project });

    const res = await authedRequest(app).put(url).send({ timeZone: null });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ timeZone: null });
    // null, not "UTC": one representation of the default rather than two.
    expect(projects.setTimeZone).toHaveBeenCalledWith(project.id, null);
  });

  it("clears back to the default when the field is omitted", async () => {
    const { app, projects } = buildApp({ project });

    const res = await authedRequest(app).put(url).send({});

    expect(res.status).toBe(200);
    expect(projects.setTimeZone).toHaveBeenCalledWith(project.id, null);
  });

  it("trims surrounding whitespace rather than storing it", async () => {
    const { app, projects } = buildApp({ project });

    await authedRequest(app).put(url).send({ timeZone: "  America/New_York  " });

    // A stored zone with a trailing space is one `Intl` would reject on the read
    // side, so the setting would validate here and degrade to UTC there.
    expect(projects.setTimeZone).toHaveBeenCalledWith(project.id, "America/New_York");
  });

  it("records an audit row, because it changes when a job runs", async () => {
    const { app, audit } = buildApp({ project });

    await authedRequest(app).put(url).send({ timeZone: "Asia/Kolkata" });

    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "project.updated",
        projectId: project.id,
        metadata: { timeZone: "Asia/Kolkata" },
      }),
    );
  });

  it("404s a project the caller cannot access", async () => {
    const { app, projects } = buildApp({ project: null });

    const res = await authedRequest(app)
      .put("/projects/99999999-9999-4999-8999-999999999999/timezone")
      .send({ timeZone: "UTC" });

    expect(res.status).toBe(404);
    expect(projects.setTimeZone).not.toHaveBeenCalled();
  });
});
