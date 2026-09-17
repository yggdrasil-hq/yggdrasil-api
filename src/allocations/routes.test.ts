import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createAllocationsRouter } from "./routes.js";
import type { SessionRecord } from "../auth/sessions.js";
import type { Project } from "../projects/types.js";
import type { User } from "../users/types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const FOREIGN_PROJECT_ID = "55555555-5555-4555-8555-555555555555";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: "Acme Storefront",
    slug: "acme-storefront",
    description: "",
    status: "ready",
    ...overrides,
  } as Project;
}

function buildApp(
  overrides: {
    /** The role roleForUser returns; undefined => "admin", null => not a member. */
    role?: string | null;
    projects?: Project[];
    tokenCap?: { projectId: string; monthlyTokenCap: number; updatedAt: Date } | null;
    resourceQuota?: {
      projectId: string;
      cpuMillicores: number;
      memoryMib: number;
      pods: number;
      updatedAt: Date;
    } | null;
    usedTokens?: number;
  } = {},
) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const users = { findById: vi.fn(async () => ({ id: USER_ID } as User)) };
  const sessions = {
    findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID } as SessionRecord)),
    touch: vi.fn(async () => undefined),
  };
  const role = overrides.role === undefined ? "admin" : overrides.role;
  const organizations = { roleForUser: vi.fn(async () => role) };

  const projectsById = new Map(
    (overrides.projects ?? [makeProject()]).map((project) => [project.id, project]),
  );
  const projects = {
    findById: vi.fn(async (id: string) => projectsById.get(id) ?? null),
  };

  const allocations = {
    findTokenCap: vi.fn(async () => overrides.tokenCap ?? null),
    findResourceQuota: vi.fn(async () => overrides.resourceQuota ?? null),
    listForOrganization: vi.fn(async () => [
      {
        projectId: PROJECT_ID,
        projectName: "Acme Storefront",
        cap: overrides.tokenCap ?? null,
        quota: overrides.resourceQuota ?? null,
      },
    ]),
    tokensUsedInPeriod: vi.fn(async () => overrides.usedTokens ?? 0),
    setTokenCap: vi.fn(async (projectId: string, cap: number) => ({
      projectId,
      monthlyTokenCap: cap,
      updatedAt: new Date(),
    })),
    clearTokenCap: vi.fn(async () => undefined),
    setResourceQuota: vi.fn(async (projectId: string, quota: Record<string, number>) => ({
      projectId,
      ...quota,
      updatedAt: new Date(),
    })),
    clearResourceQuota: vi.fn(async () => undefined),
  };

  const audit = { record: vi.fn(async () => undefined) };

  app.use(
    "/organizations",
    createAllocationsRouter({
      users: users as never,
      sessions: sessions as never,
      organizations: organizations as never,
      projects: projects as never,
      allocations: allocations as never,
      audit: audit as never,
    }),
  );

  return { app, allocations, audit };
}

const SESSION_COOKIE = "yggdrasil_session=sess_1";

function authed(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", SESSION_COOKIE),
    put: (url: string) => request(app).put(url).set("Cookie", SESSION_COOKIE),
  };
}

describe("GET /organizations/:id/allocations", () => {
  it("returns every project's effective limits and cap state", async () => {
    const { app } = buildApp({ usedTokens: 250 });
    const res = await authed(app).get(`/organizations/${ORG_ID}/allocations`);

    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(ORG_ID);
    expect(res.body.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    expect(res.body.defaults).toEqual({ cpuMillicores: 4000, memoryMib: 8192, pods: 10 });
    expect(res.body.projects[0].capState).toMatchObject({ cap: null, usedTokens: 250, exceeded: false });
  });

  it("makes the platform default explicit when a project has no override", async () => {
    const { app } = buildApp();
    const res = await authed(app).get(`/organizations/${ORG_ID}/allocations`);

    expect(res.body.projects[0].quota).toEqual({
      ...res.body.defaults,
      fromOverride: false,
    });
  });

  it("marks a project's limits as its own when an override exists", async () => {
    const { app } = buildApp({
      resourceQuota: {
        projectId: PROJECT_ID,
        cpuMillicores: 2000,
        memoryMib: 4096,
        pods: 4,
        updatedAt: new Date(),
      },
    });
    const res = await authed(app).get(`/organizations/${ORG_ID}/allocations`);

    expect(res.body.projects[0].quota).toEqual({
      cpuMillicores: 2000,
      memoryMib: 4096,
      pods: 4,
      fromOverride: true,
    });
  });

  it("is readable by a plain member — a blocked developer needs to see why", async () => {
    const { app } = buildApp({ role: "developer", usedTokens: 900, tokenCap: {
      projectId: PROJECT_ID, monthlyTokenCap: 1000, updatedAt: new Date(),
    } });
    const res = await authed(app).get(`/organizations/${ORG_ID}/allocations`);

    expect(res.status).toBe(200);
    expect(res.body.projects[0].capState.exceeded).toBe(false);
  });

  it("403s a non-member", async () => {
    const { app } = buildApp({ role: null });
    const res = await authed(app).get(`/organizations/${ORG_ID}/allocations`);
    expect(res.status).toBe(403);
  });

  it("401s an unauthenticated caller", async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/organizations/${ORG_ID}/allocations`);
    expect(res.status).toBe(401);
  });

  it("404s a malformed organization id", async () => {
    const { app } = buildApp();
    const res = await authed(app).get("/organizations/not-a-uuid/allocations");
    expect(res.status).toBe(404);
  });
});

describe("PUT .../token-cap", () => {
  it("sets a cap as an org admin and records the change", async () => {
    const { app, allocations, audit } = buildApp();
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/token-cap`,
    ).send({ monthlyTokenCap: 5_000_000 });

    expect(res.status).toBe(200);
    expect(allocations.setTokenCap).toHaveBeenCalledWith(PROJECT_ID, 5_000_000);
    expect(res.body.cap).toBe(5_000_000);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "project_token_cap.set",
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        targetId: PROJECT_ID,
      }),
    );
  });

  it("records the previous cap, so the trail shows what changed", async () => {
    const { app, audit } = buildApp({
      tokenCap: { projectId: PROJECT_ID, monthlyTokenCap: 1000, updatedAt: new Date() },
    });
    await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/token-cap`,
    ).send({ monthlyTokenCap: 2000 });

    const [, input] = audit.record.mock.calls.at(-1) as unknown as [
      unknown,
      { metadata: Record<string, unknown> },
    ];
    expect(input.metadata).toMatchObject({
      previousCap: 1000,
      monthlyTokenCap: 2000,
    });
  });

  it("clears the cap when passed null, rather than storing a sentinel", async () => {
    const { app, allocations } = buildApp();
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/token-cap`,
    ).send({ monthlyTokenCap: null });

    expect(res.status).toBe(200);
    expect(allocations.clearTokenCap).toHaveBeenCalledWith(PROJECT_ID);
    expect(allocations.setTokenCap).not.toHaveBeenCalled();
    expect(res.body.cap).toBeNull();
    expect(res.body.exceeded).toBe(false);
  });

  it("accepts 0 as a real cap (permit nothing further) rather than treating it as unset", async () => {
    const { app, allocations } = buildApp();
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/token-cap`,
    ).send({ monthlyTokenCap: 0 });

    expect(res.status).toBe(200);
    expect(allocations.setTokenCap).toHaveBeenCalledWith(PROJECT_ID, 0);
    expect(res.body.exceeded).toBe(true);
  });

  it("403s a non-admin member and writes nothing", async () => {
    const { app, allocations, audit } = buildApp({ role: "developer" });
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/token-cap`,
    ).send({ monthlyTokenCap: 1000 });

    expect(res.status).toBe(403);
    expect(allocations.setTokenCap).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("404s a project belonging to a different organization", async () => {
    const { app, allocations } = buildApp({
      projects: [makeProject({ id: FOREIGN_PROJECT_ID, organizationId: OTHER_ORG_ID })],
    });
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${FOREIGN_PROJECT_ID}/token-cap`,
    ).send({ monthlyTokenCap: 1000 });

    expect(res.status).toBe(404);
    expect(allocations.setTokenCap).not.toHaveBeenCalled();
  });

  it("400s a negative cap", async () => {
    const { app, allocations } = buildApp();
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/token-cap`,
    ).send({ monthlyTokenCap: -1 });

    expect(res.status).toBe(400);
    expect(allocations.setTokenCap).not.toHaveBeenCalled();
  });

  it("400s a non-integer cap", async () => {
    const { app } = buildApp();
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/token-cap`,
    ).send({ monthlyTokenCap: 1.5 });

    expect(res.status).toBe(400);
  });
});

describe("PUT .../quota", () => {
  const quota = { cpuMillicores: 2000, memoryMib: 4096, pods: 4 };

  it("stores a quota and reports it as an override", async () => {
    const { app, allocations, audit } = buildApp();
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/quota`,
    ).send(quota);

    expect(res.status).toBe(200);
    expect(allocations.setResourceQuota).toHaveBeenCalledWith(PROJECT_ID, quota);
    expect(res.body).toMatchObject({ ...quota, fromOverride: true });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "project_resource_quota.set", targetId: PROJECT_ID }),
    );
  });

  it("403s a non-admin member", async () => {
    const { app, allocations } = buildApp({ role: "tester" });
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/quota`,
    ).send(quota);

    expect(res.status).toBe(403);
    expect(allocations.setResourceQuota).not.toHaveBeenCalled();
  });

  it("rejects a quota that could not hold the project's own primary deployment", async () => {
    // A 1-pod / 100m namespace cannot run the primary deployment plus anything
    // else; storing it would fail every job in the namespace at admission, with
    // no obvious link back to this request.
    const { app, allocations } = buildApp();
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/quota`,
    ).send({ cpuMillicores: 1, memoryMib: 1, pods: 0 });

    expect(res.status).toBe(400);
    expect(allocations.setResourceQuota).not.toHaveBeenCalled();
  });

  it("rejects a partially-specified quota rather than defaulting the rest", async () => {
    const { app } = buildApp();
    const res = await authed(app).put(
      `/organizations/${ORG_ID}/allocations/projects/${PROJECT_ID}/quota`,
    ).send({ cpuMillicores: 2000 });

    expect(res.status).toBe(400);
  });
});
