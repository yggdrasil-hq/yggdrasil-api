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
    ownerUserId: OWNER_ID,
    name: "Test",
    slug: "test-slug",
    description: "",
    status: "ready",
    settings: {},
    installationId: "install_1",
    githubAccessWarning: false,
    modelConfigWarning: false,
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
    decryptAllForUser: vi.fn(async () => ({ ...bundle })),
    listForUser: vi.fn(async () => []),
    upsert: vi.fn(async (_userId: string, key: string, _value: string) => ({
      id: "usec_1",
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
  userSecrets?: Record<string, string>;
  activeSpecGrillJob?: unknown;
}

function buildApp(opts: BuildAppOptions) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const secrets = fakeSecrets(opts.projectSecrets);
  const userSecrets = fakeUserSecrets(opts.userSecrets);

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
  };
  const features = {
    findById: vi.fn(async () => opts.feature ?? null),
    findProjectInit: vi.fn(async () => opts.feature ?? null),
    create: vi.fn(async () => opts.feature ?? makeFeature()),
    hasBlockingStatuses: vi.fn(async () => false),
    updateStatus: vi.fn(async () => opts.feature ?? null),
    setAwaitingUserInput: vi.fn(async () => opts.feature ?? null),
    queueBuild: vi.fn(async () => opts.feature ?? null),
  };
  const jobs = {
    create: vi.fn(async () => ({ id: "job_1" })),
    hasActiveTestRunsForProject: vi.fn(async () => false),
    findActiveSpecGrillJob: vi.fn(async () => opts.activeSpecGrillJob ?? null),
  };
  const notifications = { create: vi.fn(async () => undefined) };
  const installations = {
    findById: vi.fn(async () => ({ id: "install_1", suspendedAt: null })),
    hasRepository: vi.fn(async () => true),
  };

  app.use(
    "/projects",
    createProjectsRouter({
      users: users as never,
      sessions: sessions as never,
      projects: projects as never,
      features: features as never,
      tests: {} as never,
      jobs: jobs as never,
      jobEvents: {} as never,
      jobMessages: {} as never,
      notifications: notifications as never,
      installations: installations as never,
      secrets: secrets as never,
      userSecrets: userSecrets as never,
    }),
  );

  return { app, secrets, userSecrets, features, jobs, projects };
}

const SESSION_COOKIE = "yggdrasil_session=sess_1";

function authedRequest(app: express.Express) {
  return {
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
      const { app } = buildApp({ project, userSecrets: {} });

      const res = await authedRequest(app).post("/projects").send(createBody());

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/model configuration/i);
    });

    it("succeeds and persists no project secrets when the user's default resolves", async () => {
      const project = makeProject({ status: "initializing" });
      const { app, secrets } = buildApp({
        project,
        userSecrets: {
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
      const { app, secrets, userSecrets } = buildApp({ project, userSecrets: {} });

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
      expect(userSecrets.upsert).not.toHaveBeenCalled();
    });

    it("also saves the custom bundle as the user's default when requested", async () => {
      const project = makeProject({ status: "initializing" });
      const { app, userSecrets } = buildApp({ project, userSecrets: {} });

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
      expect(userSecrets.upsert).toHaveBeenCalledWith(OWNER_ID, "MODEL_BASE_URL", "https://api.example.com/v1");
      expect(userSecrets.upsert).toHaveBeenCalledWith(OWNER_ID, "MODEL_API_KEY", "sk-custom");
      expect(userSecrets.upsert).toHaveBeenCalledWith(OWNER_ID, "MODEL_ID", "custom-model");
    });
  });

  describe("POST /projects/:projectId/features", () => {
    it("400s when the project has no resolvable model config", async () => {
      const project = makeProject();
      const { app } = buildApp({ project, userSecrets: {} });

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
        userSecrets: {
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
      const { app } = buildApp({ project, feature, userSecrets: {} });

      const res = await authedRequest(app)
        .patch(`/projects/${project.id}/features/${feature.id}`)
        .send({ startBuild: true });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/model configuration/i);
    });
  });

  describe("POST .../features/:featureId/retry-grill", () => {
    it("409s for a non-project_init feature", async () => {
      const project = makeProject();
      const feature = makeFeature({ featureType: "normal", status: "draft" });
      const { app } = buildApp({
        project,
        feature,
        userSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
      });

      const res = await authedRequest(app).post(
        `/projects/${project.id}/features/${feature.id}/retry-grill`,
      );

      expect(res.status).toBe(409);
    });

    it("409s when a grill session is already active", async () => {
      const project = makeProject();
      const feature = makeFeature({ featureType: "project_init", status: "draft" });
      const { app } = buildApp({
        project,
        feature,
        activeSpecGrillJob: { id: "job_running" },
        userSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
      });

      const res = await authedRequest(app).post(
        `/projects/${project.id}/features/${feature.id}/retry-grill`,
      );

      expect(res.status).toBe(409);
    });

    it("400s when model config still isn't resolvable", async () => {
      const project = makeProject();
      const feature = makeFeature({ featureType: "project_init", status: "draft" });
      const { app } = buildApp({ project, feature, userSecrets: {} });

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
        userSecrets: { MODEL_BASE_URL: "u", MODEL_API_KEY: "k", MODEL_ID: "m" },
      });

      const res = await authedRequest(app).post(
        `/projects/${project.id}/features/${feature.id}/retry-grill`,
      );

      expect(res.status).toBe(201);
      expect(jobs.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: project.id, kind: "spec_grill", featureId: feature.id }),
      );
    });
  });
});
