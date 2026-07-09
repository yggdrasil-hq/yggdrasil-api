import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature } from "./types.js";
import type { Project } from "../projects/types.js";
import type { GithubInstallation } from "../github/installation-repository.js";

vi.mock("../github/github-api.js", () => ({
  mintInstallationAccessToken: vi.fn(),
}));
const { mintInstallationAccessToken } = await import("../github/github-api.js");
const { createFeaturesInternalRouter } = await import("./internal-routes.js");

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "feat_1",
    projectId: "proj_1",
    title: "Add dark mode",
    slug: "add-dark-mode",
    featureType: "normal",
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

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    ownerUserId: "user_1",
    name: "Test",
    slug: "test-slug",
    description: "",
    status: "ready",
    settings: {},
    installationId: "install_1",
    githubAccessWarning: false,
    repositories: [
      { id: "repo_1", githubOwner: "acme", githubRepo: "web", isPrimary: true, sortOrder: 0 },
      { id: "repo_2", githubOwner: "acme", githubRepo: "worker", isPrimary: false, sortOrder: 1 },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeInstallation(overrides: Partial<GithubInstallation> = {}): GithubInstallation {
  return {
    id: "install_1",
    githubInstallationId: 42,
    accountType: "Organization",
    accountLogin: "acme",
    accountId: 1,
    installedByUserId: null,
    suspendedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const PROJECT_ID = "2d88c75e-7ad0-458c-8da5-ce8684ce6fa6";
const FEATURE_ID = "9f1b6b0e-7a3f-4a3a-8b8e-2e1a6f0c9a11";

function buildApp(deps: {
  features?: { findById: (projectId: string, featureId: string) => Promise<Feature | null> };
  projects?: { findById: (id: string) => Promise<Project | null> };
  installations?: { findById: (id: string) => Promise<GithubInstallation | null> };
}) {
  const app = express();
  app.use(express.json());
  app.use(
    "/internal",
    createFeaturesInternalRouter({
      features: (deps.features ?? { findById: async () => makeFeature() }) as never,
      projects: (deps.projects ?? { findById: async () => makeProject() }) as never,
      installations: (deps.installations ?? { findById: async () => makeInstallation() }) as never,
    }),
  );
  return app;
}

describe("GET /internal/projects/:projectId/features/:featureId/spec", () => {
  beforeEach(() => {
    vi.mocked(mintInstallationAccessToken).mockReset();
    vi.mocked(mintInstallationAccessToken).mockResolvedValue({
      token: "ghs_minted-token",
      expiresAt: new Date(Date.now() + 3600_000),
    });
  });

  it("returns the feature title, linked repos, and a freshly minted GitHub token", async () => {
    const app = buildApp({});

    const res = await request(app)
      .get(`/internal/projects/${PROJECT_ID}/features/${FEATURE_ID}/spec`)
      .set("Authorization", "Bearer test-internal-api-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      title: "Add dark mode",
      repos: [
        { cloneUrl: "https://github.com/acme/web.git", isPrimary: true },
        { cloneUrl: "https://github.com/acme/worker.git", isPrimary: false },
      ],
      githubToken: "ghs_minted-token",
    });
    expect(mintInstallationAccessToken).toHaveBeenCalledWith(42, expect.any(String), expect.any(String));
  });

  it("returns 404 for an unknown feature", async () => {
    const app = buildApp({ features: { findById: async () => null } });

    const res = await request(app)
      .get(`/internal/projects/${PROJECT_ID}/features/${FEATURE_ID}/spec`)
      .set("Authorization", "Bearer test-internal-api-token");

    expect(res.status).toBe(404);
    expect(mintInstallationAccessToken).not.toHaveBeenCalled();
  });

  it("returns 404 when the project has no GitHub installation", async () => {
    const app = buildApp({
      projects: { findById: async () => makeProject({ installationId: null }) },
    });

    const res = await request(app)
      .get(`/internal/projects/${PROJECT_ID}/features/${FEATURE_ID}/spec`)
      .set("Authorization", "Bearer test-internal-api-token");

    expect(res.status).toBe(404);
    expect(mintInstallationAccessToken).not.toHaveBeenCalled();
  });

  it("returns 404 for a malformed id", async () => {
    const app = buildApp({});

    const res = await request(app)
      .get(`/internal/projects/${PROJECT_ID}/features/not-a-uuid/spec`)
      .set("Authorization", "Bearer test-internal-api-token");

    expect(res.status).toBe(404);
  });

  it("rejects a missing bearer token", async () => {
    const app = buildApp({});

    const res = await request(app).get(
      `/internal/projects/${PROJECT_ID}/features/${FEATURE_ID}/spec`,
    );

    expect(res.status).toBe(401);
  });

  it("returns 502 when minting the GitHub token fails", async () => {
    vi.mocked(mintInstallationAccessToken).mockRejectedValue(new Error("token mint failed"));
    const app = buildApp({});

    const res = await request(app)
      .get(`/internal/projects/${PROJECT_ID}/features/${FEATURE_ID}/spec`)
      .set("Authorization", "Bearer test-internal-api-token");

    expect(res.status).toBe(502);
  });
});
