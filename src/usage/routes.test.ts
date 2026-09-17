import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createUsageRouter } from "./routes.js";
import type { SessionRecord } from "../auth/sessions.js";
import type { User } from "../users/types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_COOKIE = "yggdrasil_session=sess_1";

/** The window/scope a route hands the repository. */
interface ScopeArg {
  organizationId: string;
  projectId?: string;
  from: Date;
  to: Date;
  previousFrom: Date;
  recentLimit: number;
}

function emptyReport() {
  return {
    days: 30,
    from: "2026-08-18T00:00:00.000Z",
    to: "2026-09-17T00:00:00.000Z",
    totals: {
      sessions: 0,
      tokens: 0,
      costUsd: null,
      previousSessions: 0,
      previousTokens: 0,
    },
    byProvider: [],
    byKind: [],
    byProject: [],
  };
}

function buildApp(overrides: {
  /** The role findById-for-membership returns; undefined => "admin", null => not a member. */
  role?: string | null;
  /** Whether findByIdForUser resolves a project; default true. */
  projectAccessible?: boolean;
} = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const role = overrides.role === undefined ? "admin" : overrides.role;
  // The scope argument is typed so the assertions below can inspect exactly
  // what the route resolved (org, project, window) rather than a bare call.
  const organizationUsage = vi.fn(async (_scope: ScopeArg) => emptyReport());
  const organizationAnalytics = vi.fn(async (_scope: ScopeArg) => ({
    ...emptyReport(),
    activity: [],
    byModel: [],
    recentSessions: [],
  }));
  const projectUsage = vi.fn(async (_scope: ScopeArg) => emptyReport());
  const projectAnalytics = vi.fn(async (_scope: ScopeArg) => ({
    ...emptyReport(),
    activity: [],
    byModel: [],
    recentSessions: [],
  }));

  app.use(
    createUsageRouter({
      users: { findById: vi.fn(async () => ({ id: USER_ID } as User)) } as never,
      sessions: {
        findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID } as SessionRecord)),
        touch: vi.fn(async () => undefined),
      } as never,
      organizations: { roleForUser: vi.fn(async () => role) } as never,
      projects: {
        findByIdForUser: vi.fn(async () =>
          overrides.projectAccessible === false
            ? null
            : { id: PROJECT_ID, organizationId: ORG_ID },
        ),
      } as never,
      usage: {
        organizationUsage,
        organizationAnalytics,
        projectUsage,
        projectAnalytics,
      } as never,
    }),
  );

  return { app, organizationUsage, organizationAnalytics, projectUsage, projectAnalytics };
}

function authed(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", SESSION_COOKIE),
  };
}

describe("GET /organizations/:organizationId/usage", () => {
  it("returns the report to any member of the organization", async () => {
    // Not admin-only: this is the organization's own metered consumption, the
    // same visibility the members list has.
    const { app } = buildApp({ role: "developer" });

    const res = await authed(app).get(`/organizations/${ORG_ID}/usage`);

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
  });

  it("404s rather than 403s for a non-member, so org existence is not disclosed", async () => {
    const { app, organizationUsage } = buildApp({ role: null });

    const res = await authed(app).get(`/organizations/${ORG_ID}/usage`);

    expect(res.status).toBe(404);
    expect(organizationUsage).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const { app } = buildApp();

    const res = await request(app).get(`/organizations/${ORG_ID}/usage`);

    expect(res.status).toBe(401);
  });

  it("scopes the query to the requested organization and window", async () => {
    const { app, organizationUsage } = buildApp();

    await authed(app).get(`/organizations/${ORG_ID}/usage?days=7`);

    expect(organizationUsage).toHaveBeenCalledTimes(1);
    const scope = organizationUsage.mock.calls[0][0] as {
      organizationId: string;
      projectId?: string;
      from: Date;
      to: Date;
      previousFrom: Date;
    };
    expect(scope.organizationId).toBe(ORG_ID);
    expect(scope.projectId).toBeUndefined();
    expect(scope.to.getTime() - scope.from.getTime()).toBe(7 * 86_400_000);
    // The comparison window is the immediately preceding window of equal length.
    expect(scope.from.getTime() - scope.previousFrom.getTime()).toBe(7 * 86_400_000);
  });

  it("rejects an out-of-range window instead of silently clamping it", async () => {
    const { app, organizationUsage } = buildApp();

    const res = await authed(app).get(`/organizations/${ORG_ID}/usage?days=9999`);

    expect(res.status).toBe(400);
    expect(organizationUsage).not.toHaveBeenCalled();
  });

  it("404s an unknown organization id without touching the database", async () => {
    const { app, organizationUsage } = buildApp();

    const res = await authed(app).get("/organizations/not-a-uuid/usage");

    expect(res.status).toBe(404);
    expect(organizationUsage).not.toHaveBeenCalled();
  });
});

describe("GET /organizations/:organizationId/analytics", () => {
  it("returns the analytics report to a member", async () => {
    const { app, organizationAnalytics } = buildApp({ role: "product_manager" });

    const res = await authed(app).get(`/organizations/${ORG_ID}/analytics`);

    expect(res.status).toBe(200);
    expect(organizationAnalytics).toHaveBeenCalledTimes(1);
  });

  it("404s a non-member", async () => {
    const { app, organizationAnalytics } = buildApp({ role: null });

    const res = await authed(app).get(`/organizations/${ORG_ID}/analytics`);

    expect(res.status).toBe(404);
    expect(organizationAnalytics).not.toHaveBeenCalled();
  });
});

describe("project-scoped usage routes", () => {
  it("scopes project usage to that project within its own organization", async () => {
    const { app, projectUsage } = buildApp();

    const res = await authed(app).get(`/projects/${PROJECT_ID}/usage`);

    expect(res.status).toBe(200);
    const scope = projectUsage.mock.calls[0][0] as {
      organizationId: string;
      projectId?: string;
    };
    expect(scope.projectId).toBe(PROJECT_ID);
    // The organization comes from the resolved project, never from the
    // request — so a caller cannot ask for another org's numbers.
    expect(scope.organizationId).toBe(ORG_ID);
  });

  it("404s a project the caller has no access to", async () => {
    const { app, projectUsage, projectAnalytics } = buildApp({ projectAccessible: false });

    const usageRes = await authed(app).get(`/projects/${PROJECT_ID}/usage`);
    const analyticsRes = await authed(app).get(`/projects/${PROJECT_ID}/analytics`);

    expect(usageRes.status).toBe(404);
    expect(analyticsRes.status).toBe(404);
    expect(projectUsage).not.toHaveBeenCalled();
    expect(projectAnalytics).not.toHaveBeenCalled();
  });

  it("serves project analytics to anyone with project access", async () => {
    const { app, projectAnalytics } = buildApp();

    const res = await authed(app).get(`/projects/${PROJECT_ID}/analytics?days=90`);

    expect(res.status).toBe(200);
    const scope = projectAnalytics.mock.calls[0][0] as { from: Date; to: Date };
    expect(scope.to.getTime() - scope.from.getTime()).toBe(90 * 86_400_000);
  });
});
