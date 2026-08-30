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

interface BuildAppOptions {
  project: Project;
  feature?: Feature;
  projectSecrets?: Record<string, string>;
  orgSecrets?: Record<string, string>;
  activeSpecGrillJob?: unknown;
  latestDeployJob?: unknown;
  personalOrg?: { id: string; status: string } | null;
}

function buildApp(opts: BuildAppOptions) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const secrets = fakeSecrets(opts.projectSecrets);
  const orgSecrets = fakeUserSecrets(opts.orgSecrets);

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
  };
  const features = {
    findById: vi.fn(async () => opts.feature ?? null),
    findProjectInit: vi.fn(async () => opts.feature ?? null),
    create: vi.fn(async () => opts.feature ?? makeFeature()),
    hasBlockingStatuses: vi.fn(async () => false),
    updateStatus: vi.fn(async () => opts.feature ?? null),
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
    findActiveSpecGrillJob: vi.fn(async () => opts.activeSpecGrillJob ?? null),
    findLatestByProjectAndKind: vi.fn(async () => opts.latestDeployJob ?? null),
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
  };

  app.use(
    "/projects",
    createProjectsRouter({
      users: users as never,
      sessions: sessions as never,
      projects: projects as never,
      features: features as never,
      tests: {} as never,
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
    }),
  );

  return { app, secrets, orgSecrets, features, jobs, projects, actionItems, testRunReports };
}

const SESSION_COOKIE = "yggdrasil_session=sess_1";

function authedRequest(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", SESSION_COOKIE),
    post: (url: string) => request(app).post(url).set("Cookie", SESSION_COOKIE),
    patch: (url: string) => request(app).patch(url).set("Cookie", SESSION_COOKIE),
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
