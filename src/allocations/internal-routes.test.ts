import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createAllocationsInternalRouter } from "./internal-routes.js";
import type { Project } from "../projects/types.js";

const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "22222222-2222-4222-8222-222222222222";

function makeProject(): Project {
  return {
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: "Acme Storefront",
    slug: "acme-storefront",
    description: "",
    status: "ready",
  } as Project;
}

function buildApp(
  overrides: {
    monthlyTokenCap?: number | null;
    usedTokens?: number;
    quota?: { cpuMillicores: number; memoryMib: number; pods: number } | null;
    projectFound?: boolean;
  } = {},
) {
  const app = express();
  app.use(express.json());

  const projects = {
    findById: vi.fn(async () => (overrides.projectFound === false ? null : makeProject())),
  };
  const allocations = {
    findTokenCap: vi.fn(async () =>
      overrides.monthlyTokenCap === undefined || overrides.monthlyTokenCap === null
        ? null
        : { projectId: PROJECT_ID, monthlyTokenCap: overrides.monthlyTokenCap, updatedAt: new Date() },
    ),
    findResourceQuota: vi.fn(async () =>
      overrides.quota
        ? { projectId: PROJECT_ID, ...overrides.quota, updatedAt: new Date() }
        : null,
    ),
    tokensUsedInPeriod: vi.fn(async () => overrides.usedTokens ?? 0),
  };

  app.use(
    "/internal",
    createAllocationsInternalRouter({
      projects: projects as never,
      allocations: allocations as never,
    }),
  );

  return { app, allocations };
}

const TOKEN = "test-internal-api-token";
function get(app: express.Express, url: string) {
  return request(app).get(url).set("Authorization", `Bearer ${TOKEN}`);
}

describe("GET /internal/projects/:id/token-cap", () => {
  it("denies a token-consuming kind once the cap is reached", async () => {
    const { app } = buildApp({ monthlyTokenCap: 1000, usedTokens: 1000 });
    const res = await get(app, `/internal/projects/${PROJECT_ID}/token-cap?kind=feature_build`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      allowed: false,
      cap: 1000,
      usedTokens: 1000,
      exceeded: true,
    });
  });

  it("allows the same project for a deterministic kind — a cap cannot block a deploy", async () => {
    const { app } = buildApp({ monthlyTokenCap: 1000, usedTokens: 999_999 });
    const res = await get(app, `/internal/projects/${PROJECT_ID}/token-cap?kind=deploy`);

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
    expect(res.body.consumesTokens).toBe(false);
    // The state is still reported, so the caller can log why nothing happened
    // for a kind that *would* have been blocked.
    expect(res.body.exceeded).toBe(true);
  });

  it("allows rollback and script_test_run even when far over cap", async () => {
    const { app } = buildApp({ monthlyTokenCap: 1, usedTokens: 5000 });
    for (const kind of ["rollback", "script_test_run"]) {
      const res = await get(app, `/internal/projects/${PROJECT_ID}/token-cap?kind=${kind}`);
      expect(res.body.allowed).toBe(true);
    }
  });

  it("allows everything when the project has no cap", async () => {
    const { app } = buildApp({ usedTokens: 10_000_000 });
    const res = await get(app, `/internal/projects/${PROJECT_ID}/token-cap?kind=spec_grill`);

    expect(res.body).toMatchObject({ allowed: true, cap: null, exceeded: false });
  });

  it("is allowed one token under the cap", async () => {
    const { app } = buildApp({ monthlyTokenCap: 1000, usedTokens: 999 });
    const res = await get(app, `/internal/projects/${PROJECT_ID}/token-cap?kind=spec_grill`);
    expect(res.body.allowed).toBe(true);
  });

  it("scopes the usage read to the current period", async () => {
    const { app, allocations } = buildApp({ monthlyTokenCap: 1000, usedTokens: 5 });
    await get(app, `/internal/projects/${PROJECT_ID}/token-cap?kind=spec_grill`);

    const [, from, to] = allocations.tokensUsedInPeriod.mock.calls[0] as unknown as [
      string,
      Date,
      Date,
    ];
    expect(from.toISOString()).toMatch(/-01T00:00:00\.000Z$/);
    expect(to.getTime()).toBeGreaterThan(from.getTime());
  });

  it("treats a missing kind as non-consuming rather than assuming the worst", async () => {
    const { app } = buildApp({ monthlyTokenCap: 0 });
    const res = await get(app, `/internal/projects/${PROJECT_ID}/token-cap`);
    expect(res.body.allowed).toBe(true);
  });

  it("404s an unknown project", async () => {
    const { app } = buildApp({ projectFound: false });
    const res = await get(app, `/internal/projects/${PROJECT_ID}/token-cap?kind=spec_grill`);
    expect(res.status).toBe(404);
  });

  it("401s without the internal bearer token", async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/internal/projects/${PROJECT_ID}/token-cap?kind=spec_grill`);
    expect(res.status).toBe(401);
  });
});

describe("GET /internal/projects/:id/resource-quota", () => {
  it("returns the platform default when the project has no override", async () => {
    const { app } = buildApp({ quota: null });
    const res = await get(app, `/internal/projects/${PROJECT_ID}/resource-quota`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projectId: PROJECT_ID,
      cpuMillicores: 4000,
      memoryMib: 8192,
      pods: 10,
      fromOverride: false,
    });
  });

  it("returns the stored override when there is one", async () => {
    const { app } = buildApp({ quota: { cpuMillicores: 2000, memoryMib: 4096, pods: 4 } });
    const res = await get(app, `/internal/projects/${PROJECT_ID}/resource-quota`);

    expect(res.body).toMatchObject({
      cpuMillicores: 2000,
      memoryMib: 4096,
      pods: 4,
      fromOverride: true,
    });
  });

  it("404s an unknown project", async () => {
    const { app } = buildApp({ projectFound: false });
    const res = await get(app, `/internal/projects/${PROJECT_ID}/resource-quota`);
    expect(res.status).toBe(404);
  });
});
