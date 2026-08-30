import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDesignsInternalRouter } from "./internal-routes.js";
import type { Job } from "../jobs/types.js";
import type { Project } from "../projects/types.js";

vi.mock("../github/github-api.js", () => ({
  mintInstallationAccessToken: vi.fn(),
}));
const { mintInstallationAccessToken } = await import("../github/github-api.js");

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function makeProject(): Project {
  return {
    id: PROJECT_ID,
    organizationId: "org_1",
    ownerUserId: "user_1",
    name: "Test",
    slug: "test",
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
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    kind: "design_grill",
    featureId: null,
    testId: null,
    ref: null,
    trigger: null,
    designName: "Checkout",
    designSlug: "checkout",
    designDescription: "A checkout flow",
    status: "pending",
    lastError: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function buildApp(job = makeJob()) {
  const app = express();
  app.use(
    "/internal",
    createDesignsInternalRouter({
      projects: { findById: async () => makeProject() } as never,
      jobs: { findByIdForProject: async () => job } as never,
      installations: {
        findById: async () => ({
          id: "install_1",
          githubInstallationId: 42,
          accountType: "Organization",
          accountLogin: "acme",
          accountId: 1,
          installedByUserId: null,
          suspendedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      } as never,
    }),
  );
  return app;
}

describe("GET /internal/projects/:projectId/designs/:sessionId/spec", () => {
  beforeEach(() => {
    vi.mocked(mintInstallationAccessToken).mockResolvedValue({
      token: "ghs_design-token",
      expiresAt: new Date(Date.now() + 3600_000),
    });
  });

  it("returns the design payload and write-scoped token", async () => {
    const response = await request(buildApp())
      .get(`/internal/projects/${PROJECT_ID}/designs/${SESSION_ID}/spec`)
      .set("Authorization", "Bearer test-internal-api-token");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: "Checkout",
      slug: "checkout",
      description: "A checkout flow",
      branch: `yggdrasil/design-checkout-${SESSION_ID}`,
      githubToken: "ghs_design-token",
      repos: [{ cloneUrl: "https://github.com/acme/web.git", isPrimary: true }],
    });
    expect(mintInstallationAccessToken).toHaveBeenCalledWith(
      42,
      expect.any(String),
      expect.any(String),
      { contents: "write", pull_requests: "write" },
    );
  });

  it("rejects a non-design job", async () => {
    const response = await request(buildApp(makeJob({ kind: "feature_build" })))
      .get(`/internal/projects/${PROJECT_ID}/designs/${SESSION_ID}/spec`)
      .set("Authorization", "Bearer test-internal-api-token");
    expect(response.status).toBe(404);
  });
});
