import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createProjectsInternalRouter } from "./internal-routes.js";
import type { Project } from "./types.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    organizationId: "org_1",
    ownerUserId: "user_1",
    name: "Test",
    slug: "test-slug",
    description: "",
    status: "ready",
    settings: {},
    installationId: null,
    githubAccessWarning: false,
    modelConfigWarning: false,
    agenticReviewEnabled: true,
    repositories: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildApp(projects: { findById: (id: string) => Promise<Project | null> }) {
  const app = express();
  app.use(express.json());
  app.use(
    "/internal",
    createProjectsInternalRouter({
      projects: projects as never,
      installations: {} as never,
    }),
  );
  return app;
}

describe("GET /internal/projects/:projectId/slug", () => {
  it("returns the project's slug with a valid bearer token", async () => {
    const app = buildApp({ findById: async () => makeProject({ slug: "acme-web" }) });

    const res = await request(app)
      .get("/internal/projects/2d88c75e-7ad0-458c-8da5-ce8684ce6fa6/slug")
      .set("Authorization", "Bearer test-internal-api-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "acme-web" });
  });

  it("returns 404 for an unknown project", async () => {
    const app = buildApp({ findById: async () => null });

    const res = await request(app)
      .get("/internal/projects/2d88c75e-7ad0-458c-8da5-ce8684ce6fa6/slug")
      .set("Authorization", "Bearer test-internal-api-token");

    expect(res.status).toBe(404);
  });

  it("returns 404 for a malformed project id", async () => {
    const app = buildApp({ findById: async () => makeProject() });

    const res = await request(app)
      .get("/internal/projects/not-a-uuid/slug")
      .set("Authorization", "Bearer test-internal-api-token");

    expect(res.status).toBe(404);
  });

  it("rejects a missing bearer token", async () => {
    const app = buildApp({ findById: async () => makeProject() });

    const res = await request(app).get(
      "/internal/projects/2d88c75e-7ad0-458c-8da5-ce8684ce6fa6/slug",
    );

    expect(res.status).toBe(401);
  });
});
