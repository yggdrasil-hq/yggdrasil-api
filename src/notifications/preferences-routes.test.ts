import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createNotificationPreferencesRouter } from "./preferences-routes.js";
import { NOTIFICATION_KINDS } from "./preferences.js";
import type { SessionRecord } from "../auth/sessions.js";
import type { Project } from "../projects/types.js";
import type { User } from "../users/types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_COOKIE = "yggdrasil_session=sess_1";

function buildApp(overrides: {
  /** Membership role the org repository reports; null => not a member. */
  role?: string | null;
  preferences?: Array<{ id: string; userId: string; organizationId: string; kind: string | null; enabled: boolean }>;
  mutedProjectIds?: string[];
  /** null => the project is not visible to this user. */
  project?: Project | null;
} = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const users = { findById: vi.fn(async () => ({ id: USER_ID } as User)) };
  const sessions = {
    findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID } as SessionRecord)),
    touch: vi.fn(async () => undefined),
  };
  const role = overrides.role === undefined ? "developer" : overrides.role;
  const organizations = { roleForUser: vi.fn(async () => role) };
  const project = overrides.project === undefined ? ({ id: PROJECT_ID } as Project) : overrides.project;
  const projects = { findByIdForUser: vi.fn(async () => project) };
  const preferencesRepo = {
    listForUserOrganization: vi.fn(async () => overrides.preferences ?? []),
    listMutedProjectIds: vi.fn(async () => overrides.mutedProjectIds ?? []),
    setPreference: vi.fn(
      async (input: { kind: string | null; enabled: boolean }) => ({
        id: "pref_1",
        userId: USER_ID,
        organizationId: ORG_ID,
        kind: input.kind,
        enabled: input.enabled,
      }),
    ),
    setProjectMute: vi.fn(async () => undefined),
    organizationIdForProject: vi.fn(async () => ORG_ID),
    isProjectMuted: vi.fn(async () => false),
  };

  app.use(
    "/settings",
    createNotificationPreferencesRouter({
      users: users as never,
      sessions: sessions as never,
      organizations: organizations as never,
      projects: projects as never,
      preferences: preferencesRepo as never,
    }),
  );

  return { app, organizations, projects, preferencesRepo };
}

function authedRequest(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", SESSION_COOKIE),
    put: (url: string) => request(app).put(url).set("Cookie", SESSION_COOKIE),
  };
}

describe("notification preferences router (ADR 027)", () => {
  it("requires authentication", async () => {
    const { app } = buildApp();
    const res = await request(app).get(`/settings/notification-preferences?org=${ORG_ID}`);
    expect(res.status).toBe(401);
  });

  it("rejects a missing or malformed organization id", async () => {
    const { app } = buildApp();
    expect((await authedRequest(app).get("/settings/notification-preferences")).status).toBe(400);
    expect(
      (await authedRequest(app).get("/settings/notification-preferences?org=nope")).status,
    ).toBe(400);
  });

  /** Default-notify: a member with no rows sees every kind switched on. */
  it("returns every known kind enabled by default", async () => {
    const { app } = buildApp({ preferences: [] });
    const res = await authedRequest(app).get(
      `/settings/notification-preferences?org=${ORG_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.organizationId).toBe(ORG_ID);
    // Master row first, then one entry per registered kind.
    expect(res.body.preferences).toHaveLength(NOTIFICATION_KINDS.length + 1);
    expect(res.body.preferences[0]).toMatchObject({ kind: null, enabled: true });
    for (const entry of res.body.preferences) {
      expect(entry.enabled).toBe(true);
    }
    expect(res.body.mutedProjectIds).toEqual([]);
  });

  it("reports a concrete kind row as the effective value, and the org row as the fallback", async () => {
    const { app } = buildApp({
      preferences: [
        // enough of a row for the router's serialization; the repository fake
        // is what the router reads
        { id: "p1", userId: USER_ID, organizationId: ORG_ID, kind: null, enabled: false },
        { id: "p2", userId: USER_ID, organizationId: ORG_ID, kind: "adr_approved", enabled: true },
      ],
    });
    const res = await authedRequest(app).get(
      `/settings/notification-preferences?org=${ORG_ID}`,
    );

    const byKind = new Map<string, boolean>(
      res.body.preferences.map(
        (entry: { kind: string | null; enabled: boolean }) => [
          entry.kind === null ? "__all__" : entry.kind,
          entry.enabled,
        ],
      ),
    );
    // A concrete row wins for its own kind; everything else follows the
    // org-wide row, which this user turned off.
    expect(byKind.get("adr_approved")).toBe(true);
    expect(byKind.get("__all__")).toBe(false);
    const otherKind = NOTIFICATION_KINDS.find((kind) => kind !== "adr_approved");
    expect(byKind.get(otherKind!)).toBe(false);
  });

  it("returns 404 for a non-member rather than confirming the org exists", async () => {
    const { app } = buildApp({ role: null });
    const res = await authedRequest(app).get(
      `/settings/notification-preferences?org=${ORG_ID}`,
    );
    expect(res.status).toBe(404);
  });

  it("lets any member set a kind preference, including the org-wide row", async () => {
    const { app, preferencesRepo } = buildApp({ role: "tester" });
    const res = await authedRequest(app)
      .put("/settings/notification-preferences")
      .send({ organizationId: ORG_ID, kind: "build_started", enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "build_started", enabled: false });
    expect(preferencesRepo.setPreference).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: ORG_ID,
      kind: "build_started",
      enabled: false,
    });

    const master = await authedRequest(app)
      .put("/settings/notification-preferences")
      .send({ organizationId: ORG_ID, kind: null, enabled: false });
    expect(master.status).toBe(200);
    expect(master.body).toMatchObject({ kind: null, enabled: false });
  });

  it("rejects an unknown kind and a non-member on the write path", async () => {
    const { app } = buildApp();
    const unknown = await authedRequest(app)
      .put("/settings/notification-preferences")
      .send({ organizationId: ORG_ID, kind: "feature_build", enabled: false });
    expect(unknown.status).toBe(400);

    const { app: nonMemberApp } = buildApp({ role: null });
    const forbidden = await authedRequest(nonMemberApp)
      .put("/settings/notification-preferences")
      .send({ organizationId: ORG_ID, kind: "adr_approved", enabled: false });
    expect(forbidden.status).toBe(404);
  });

  it("mutes and unmutes a project the user can see", async () => {
    const { app, preferencesRepo } = buildApp({});
    const muted = await authedRequest(app)
      .put(`/settings/notification-preferences/projects/${PROJECT_ID}`)
      .send({ muted: true });

    expect(muted.status).toBe(200);
    expect(muted.body).toEqual({ projectId: PROJECT_ID, muted: true });
    expect(preferencesRepo.setProjectMute).toHaveBeenCalledWith(USER_ID, PROJECT_ID, true);

    const unmuted = await authedRequest(app)
      .put(`/settings/notification-preferences/projects/${PROJECT_ID}`)
      .send({ muted: false });
    expect(unmuted.status).toBe(200);
    expect(preferencesRepo.setProjectMute).toHaveBeenLastCalledWith(
      USER_ID,
      PROJECT_ID,
      false,
    );
  });

  it("refuses to mute a project the user cannot see", async () => {
    const { app, preferencesRepo } = buildApp({ project: null });
    const res = await authedRequest(app)
      .put(`/settings/notification-preferences/projects/${PROJECT_ID}`)
      .send({ muted: true });

    expect(res.status).toBe(404);
    expect(preferencesRepo.setProjectMute).not.toHaveBeenCalled();
  });

  it("rejects a malformed project id and a missing muted flag", async () => {
    const { app } = buildApp();
    expect(
      (
        await authedRequest(app)
          .put("/settings/notification-preferences/projects/not-a-uuid")
          .send({ muted: true })
      ).status,
    ).toBe(404);
    expect(
      (
        await authedRequest(app)
          .put(`/settings/notification-preferences/projects/${PROJECT_ID}`)
          .send({})
      ).status,
    ).toBe(400);
  });
});
