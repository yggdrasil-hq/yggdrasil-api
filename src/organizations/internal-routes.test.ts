import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationsInternalRouter } from "./internal-routes.js";
import type { Project } from "../projects/types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    organizationId: ORG_ID,
    ownerUserId: "owner_1",
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
    ...overrides,
  };
}

const KUBECONFIG = "apiVersion: v1\nclusters: []\n";

function buildApp(overrides: {
  kubeconfig?: string | null;
} = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const projects = {
    findById: vi.fn(async () => makeProject()),
  };
  const clusters = {
    decryptKubeconfig: vi.fn(async () =>
      overrides.kubeconfig === undefined ? KUBECONFIG : overrides.kubeconfig,
    ),
  };

  app.use(
    "/internal",
    createOrganizationsInternalRouter({
      projects: projects as never,
      clusters: clusters as never,
    }),
  );

  return { app, projects, clusters };
}

describe("organizations internal router (ADR 016 cluster resolution)", () => {
  it("returns the org id and decrypted kubeconfig for a project", async () => {
    const { app } = buildApp();
    const res = await request(app)
      .get(`/internal/projects/${PROJECT_ID}/organization-cluster`)
      .set("Authorization", "Bearer test-internal-api-token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ organizationId: ORG_ID, kubeconfig: KUBECONFIG });
  });

  it("409s when the org has no cluster configured (hard gate)", async () => {
    const { app } = buildApp({ kubeconfig: null });
    const res = await request(app)
      .get(`/internal/projects/${PROJECT_ID}/organization-cluster`)
      .set("Authorization", "Bearer test-internal-api-token");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no cluster/i);
  });

  it("401s without the internal bearer token", async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/internal/projects/${PROJECT_ID}/organization-cluster`);
    expect(res.status).toBe(401);
  });

  it("404s for an unknown project", async () => {
    const { app, projects } = buildApp();
    projects.findById.mockResolvedValue(null as never);
    const res = await request(app)
      .get(`/internal/projects/${PROJECT_ID}/organization-cluster`)
      .set("Authorization", "Bearer test-internal-api-token");
    expect(res.status).toBe(404);
  });
});