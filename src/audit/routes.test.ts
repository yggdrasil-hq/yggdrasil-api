import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createAuditRouter } from "./routes.js";
import { AUDIT_DEFAULT_LIMIT } from "./types.js";
import type { SessionRecord } from "../auth/sessions.js";
import type { User } from "../users/types.js";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const ACTOR_ID = "44444444-4444-4444-8444-444444444444";

function auditRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    projectName: "Test",
    actorUserId: USER_ID,
    actorUsername: "sarat",
    actorDisplayName: "Sarat Angajala",
    actorKind: "user" as const,
    action: "project.created",
    targetType: "project",
    targetId: PROJECT_ID,
    metadata: {},
    ip: "203.0.113.7",
    createdAt: new Date("2026-09-16T10:00:00.000Z"),
    ...overrides,
  };
}

function buildApp(overrides: { role?: string | null } = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const users = {
    findById: vi.fn(async () => ({ id: USER_ID } as User)),
  };
  const sessions = {
    findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID } as SessionRecord)),
    touch: vi.fn(async () => undefined),
  };
  const role = overrides.role === undefined ? "admin" : overrides.role;
  const organizations = {
    roleForUser: vi.fn(async () => role),
  };
  const audit = {
    listForOrganization: vi.fn(
      async (_orgId: string, _options: Record<string, unknown>) => ({
        events: [auditRow()],
        total: 1,
      }),
    ),
  };

  app.use(
    "/organizations",
    createAuditRouter({
      users: users as never,
      sessions: sessions as never,
      organizations: organizations as never,
      audit: audit as never,
    }),
  );

  return { app, audit, organizations };
}

const SESSION_COOKIE = "yggdrasil_session=sess_1";

function authedGet(app: express.Express, url: string) {
  return request(app).get(url).set("Cookie", SESSION_COOKIE);
}

describe("audit router (ADR 028)", () => {
  it("returns the org's trail with pagination metadata for an admin", async () => {
    const { app, audit } = buildApp({ role: "admin" });

    const res = await authedGet(app, `/organizations/${ORG_ID}/audit`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.limit).toBe(AUDIT_DEFAULT_LIMIT);
    expect(res.body.offset).toBe(0);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      id: "evt_1",
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      projectName: "Test",
      actorUsername: "sarat",
      action: "project.created",
      createdAt: "2026-09-16T10:00:00.000Z",
    });
    expect(audit.listForOrganization).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ limit: AUDIT_DEFAULT_LIMIT, offset: 0 }),
    );
  });

  it("is admin-only: a non-admin member gets 403 and nothing is read", async () => {
    const { app, audit } = buildApp({ role: "developer" });

    const res = await authedGet(app, `/organizations/${ORG_ID}/audit`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Admin role required" });
    expect(audit.listForOrganization).not.toHaveBeenCalled();
  });

  it("is admin-only: a non-member gets 403 and nothing is read", async () => {
    const { app, audit } = buildApp({ role: null });

    const res = await authedGet(app, `/organizations/${ORG_ID}/audit`);

    expect(res.status).toBe(403);
    expect(audit.listForOrganization).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller before any authorization work", async () => {
    const { app, organizations } = buildApp();

    const res = await request(app).get(`/organizations/${ORG_ID}/audit`);

    expect(res.status).toBe(401);
    expect(organizations.roleForUser).not.toHaveBeenCalled();
  });

  it("404s a non-uuid organization id", async () => {
    const { app, audit } = buildApp();

    const res = await authedGet(app, "/organizations/not-a-uuid/audit");

    expect(res.status).toBe(404);
    expect(audit.listForOrganization).not.toHaveBeenCalled();
  });

  it("passes pagination through to the repository", async () => {
    const { app, audit } = buildApp();

    const res = await authedGet(app, `/organizations/${ORG_ID}/audit?limit=10&offset=20`);

    expect(res.status).toBe(200);
    expect(audit.listForOrganization).toHaveBeenCalledWith(
      ORG_ID,
      expect.objectContaining({ limit: 10, offset: 20 }),
    );
    expect(res.body.limit).toBe(10);
    expect(res.body.offset).toBe(20);
  });

  it("passes every documented filter through, dates included", async () => {
    const { app, audit } = buildApp();

    const res = await authedGet(
      app,
      `/organizations/${ORG_ID}/audit?projectId=${PROJECT_ID}&actorUserId=${ACTOR_ID}` +
        `&action=project.&from=2026-09-01&to=2026-09-30T12:00:00.000Z`,
    );

    expect(res.status).toBe(200);
    const [, options] = audit.listForOrganization.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(options.projectId).toBe(PROJECT_ID);    expect(options.actorUserId).toBe(ACTOR_ID);
    expect(options.action).toBe("project.");
    expect((options.from as Date).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect((options.to as Date).toISOString()).toBe("2026-09-30T12:00:00.000Z");
  });

  it("leaves filters undefined when they aren't supplied", async () => {
    const { app, audit } = buildApp();

    await authedGet(app, `/organizations/${ORG_ID}/audit`);

    const [, options] = audit.listForOrganization.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(options.projectId).toBeUndefined();
    expect(options.actorUserId).toBeUndefined();
    expect(options.action).toBeUndefined();
    expect(options.from).toBeUndefined();
    expect(options.to).toBeUndefined();
  });

  it("rejects a malformed filter instead of silently ignoring it", async () => {
    const { app, audit } = buildApp();

    const badProject = await authedGet(
      app,
      `/organizations/${ORG_ID}/audit?projectId=not-a-uuid`,
    );
    expect(badProject.status).toBe(400);

    const badDate = await authedGet(app, `/organizations/${ORG_ID}/audit?from=yesterday`);
    expect(badDate.status).toBe(400);

    expect(audit.listForOrganization).not.toHaveBeenCalled();
  });

  it("caps the page size so one request can't scan the whole trail", async () => {
    const { app, audit } = buildApp();

    const res = await authedGet(app, `/organizations/${ORG_ID}/audit?limit=5000`);

    expect(res.status).toBe(400);
    expect(audit.listForOrganization).not.toHaveBeenCalled();
  });

  it("rejects a zero limit", async () => {
    const { app } = buildApp();
    const res = await authedGet(app, `/organizations/${ORG_ID}/audit?limit=0`);
    expect(res.status).toBe(400);
  });
});
