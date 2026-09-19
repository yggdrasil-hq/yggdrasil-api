import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createOrganizationsRouter } from "./routes.js";
import type { Organization } from "./types.js";
import { AGENT_JOB_KINDS } from "../model-config/types.js";
import type { SessionRecord } from "../auth/sessions.js";
import type { User } from "../users/types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";

function makeOrg(overrides: Partial<Organization> = {}): Organization {
  return {
    id: ORG_ID,
    name: "Acme Retail",
    slug: "acme-retail",
    description: "",
    isPersonal: false,
    status: "pending_cluster",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildApp(overrides: {
  /** The role findById-for-membership returns; undefined => "admin", null => not a member. */
  role?: string | null;
  members?: Array<Record<string, unknown>>;
  /* --- Issue #35: the readiness knobs a test varies --- */
  /** The orgs `listForUser` returns; defaults to one org using the `role` above. */
  orgs?: Organization[];
  /** Defaults to all five kinds pointing at one resolvable model. */
  jobDefaults?: Array<{
    organizationId: string;
    jobKind: string;
    modelId: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  /** false => the default's catalog model no longer exists. */
  catalogModelExists?: boolean;
  /** false => the default's provider key is unreadable. */
  providerKeyReadable?: boolean;
  /** false => the provider row is gone. */
  providerExists?: boolean;
} = {}) {
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
  const roleForUserRole = overrides.role === undefined ? "admin" : overrides.role;
  const organizations = {
    roleForUser: vi.fn(async () => roleForUserRole),
    findById: vi.fn(async () => makeOrg()),
    listForUser: vi.fn(async () => overrides.orgs ?? [makeOrg()]),
    create: vi.fn(async () => makeOrg()),
    update: vi.fn(async () => makeOrg()),
    membership: vi.fn(async () => null),
    listMembers: vi.fn(async () => overrides.members ?? []),
    setRole: vi.fn(async () => true),
    removeMember: vi.fn(async () => true),
    addMember: vi.fn(async () => "developer"),
    countAdmins: vi.fn(async () => 2),
    createInvite: vi.fn(async (input: { organizationId: string; role: string }) => ({
      id: "inv_1",
      organizationId: input.organizationId,
      token: "abc123",
      role: input.role,
      createdByUserId: USER_ID,
      createdAt: new Date(),
    })),
    setStatus: vi.fn(async () => makeOrg()),
    listInvites: vi.fn(async () => []),
    revokeInvite: vi.fn(async () => true),
    findByInviteToken: vi.fn(async () => null),
    listRoleCapabilities: vi.fn(async () => []),
  };
  const clusters = {
    findMetadata: vi.fn(async () => null),
    upsert: vi.fn(async () => ({
      id: "cluster_1",
      organizationId: ORG_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    delete: vi.fn(async () => true),
    decryptKubeconfig: vi.fn(async () => null),
  };
  const orgSecrets = {
    listForOrganization: vi.fn(async () => []),
    upsert: vi.fn(async (_orgId: string, key: string, _value: string) => ({
      id: "osec_1",
      key,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    delete: vi.fn(async () => true),
    decryptAllForOrganization: vi.fn(async () => ({})),
  };

  const audit = {
    record: vi.fn(async (_res: unknown, _input: Record<string, unknown>) => undefined),
  };

  /*
   * Issue #35: the model-config repositories the shared readiness predicate reads.
   *
   * The defaults are deliberately **complete and resolvable** (all five kinds
   * pointing at one catalog model whose provider key decrypts), so an org's
   * `ready` depends on the two things a test means to vary — its `status` and
   * these — rather than on an incidental missing row. A test that wants an unready
   * org overrides exactly the piece it is about.
   */
  const provider = {
    id: "provider_1",
    organizationId: ORG_ID,
    providerType: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  };
  const catalogModel = {
    id: "model_1",
    organizationId: ORG_ID,
    providerId: provider.id,
    modelId: "gpt-4.1",
  };
  const providers = {
    findById: vi.fn(async () => (overrides.providerExists === false ? null : provider)),
    decryptApiKey: vi.fn(async () =>
      overrides.providerKeyReadable === false ? null : "sk-live",
    ),
  };
  const models = {
    findById: vi.fn(async () =>
      overrides.catalogModelExists === false ? null : catalogModel,
    ),
  };
  const jobDefaults = {
    listForOrganization: vi.fn(
      async () =>
        overrides.jobDefaults ??
        AGENT_JOB_KINDS.map((jobKind) => ({
          organizationId: ORG_ID,
          jobKind,
          modelId: catalogModel.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
    ),
    findForJobKind: vi.fn(async (_orgId: string, jobKind: string) => ({
      organizationId: ORG_ID,
      jobKind,
      modelId: catalogModel.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  };

  app.use(
    "/organizations",
    createOrganizationsRouter({
      users: users as never,
      sessions: sessions as never,
      organizations: organizations as never,
      clusters: clusters as never,
      orgSecrets: orgSecrets as never,
      audit: audit as never,
      providers: providers as never,
      models: models as never,
      jobDefaults: jobDefaults as never,
    }),
  );

  return { app, organizations, clusters, orgSecrets, audit, providers, models, jobDefaults };
}

const SESSION_COOKIE = "yggdrasil_session=sess_1";

function authedRequest(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", SESSION_COOKIE),
    post: (url: string) => request(app).post(url).set("Cookie", SESSION_COOKIE),
    patch: (url: string) => request(app).patch(url).set("Cookie", SESSION_COOKIE),
    put: (url: string) => request(app).put(url).set("Cookie", SESSION_COOKIE),
    delete: (url: string) => request(app).delete(url).set("Cookie", SESSION_COOKIE),
  };
}

describe("organizations router (ADR 016 track A1)", () => {
  it("GET /organizations lists the user's orgs with their roles", async () => {
    const { app } = buildApp({ role: "admin" });
    const res = await authedRequest(app).get("/organizations");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ id: ORG_ID, role: "admin" });
  });

  it("POST /organizations creates an org with the creator as admin", async () => {
    const { app, organizations } = buildApp();
    const res = await authedRequest(app)
      .post("/organizations")
      .send({ name: "Acme Retail" });
    expect(res.status).toBe(201);
    expect(organizations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Acme Retail",
        isPersonal: false,
        creatorUserId: USER_ID,
      }),
    );
    expect(res.body).toMatchObject({ role: "admin" });
  });

  it("401s without a session", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/organizations");
    expect(res.status).toBe(401);
  });

  it("404s for an org the caller isn't a member of", async () => {
    const { app } = buildApp({ role: null });
    const res = await authedRequest(app).get(`/organizations/${ORG_ID}`);
    expect(res.status).toBe(404);
  });

  describe("member role management", () => {
    it("PATCH members/:userId updates the role under admin", async () => {
      const { app, organizations } = buildApp({ role: "admin" });
      const res = await authedRequest(app)
        .patch(`/organizations/${ORG_ID}/members/${OTHER_USER_ID}`)
        .send({ role: "developer" });
      expect(res.status).toBe(200);
      expect(organizations.setRole).toHaveBeenCalledWith(ORG_ID, OTHER_USER_ID, "developer");
    });

    it("403s when the caller isn't an admin", async () => {
      const { app, organizations } = buildApp({ role: "developer" });
      const res = await authedRequest(app)
        .patch(`/organizations/${ORG_ID}/members/${OTHER_USER_ID}`)
        .send({ role: "developer" });
      expect(res.status).toBe(403);
      expect(organizations.setRole).not.toHaveBeenCalled();
    });

    it("409s when demoting the last admin", async () => {
      const { app, organizations } = buildApp({ role: "admin" });
      (organizations.roleForUser as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async (_orgId: string, userId: string) => (userId === OTHER_USER_ID ? "admin" : "admin"),
      );
      organizations.countAdmins.mockResolvedValue(1);
      const res = await authedRequest(app)
        .patch(`/organizations/${ORG_ID}/members/${OTHER_USER_ID}`)
        .send({ role: "developer" });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/at least one Admin/);
    });
  });

  describe("invites", () => {
    it("POST invites creates a shareable token link (admin only)", async () => {
      const { app, organizations } = buildApp({ role: "admin" });
      const res = await authedRequest(app)
        .post(`/organizations/${ORG_ID}/invites`)
        .send({ role: "developer" });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ token: "abc123", role: "developer" });
    });

    it("403s invite creation for a non-admin", async () => {
      const { app, organizations } = buildApp({ role: "designer" });
      const res = await authedRequest(app)
        .post(`/organizations/${ORG_ID}/invites`)
        .send({ role: "developer" });
      expect(res.status).toBe(403);
      expect(organizations.createInvite).not.toHaveBeenCalled();
    });

    it("POST invites/:token/accept adds the caller as a member", async () => {
      const { app, organizations } = buildApp({ role: null });
      organizations.findByInviteToken.mockResolvedValue({
        id: "inv_1",
        organizationId: ORG_ID,
        token: "tok",
        role: "developer",
        createdByUserId: OTHER_USER_ID,
        createdAt: new Date(),
      } as never);
      const res = await authedRequest(app).post("/organizations/invites/tok/accept");
      expect(res.status).toBe(201);
      expect(organizations.addMember).toHaveBeenCalledWith(ORG_ID, USER_ID, "developer");
      expect(res.body.organization).toMatchObject({ role: "developer" });
    });

    it("404s accept for an unknown or revoked token", async () => {
      const { app, organizations } = buildApp({ role: null });
      const res = await authedRequest(app).post("/organizations/invites/unknown/accept");
      expect(res.status).toBe(404);
      expect(organizations.addMember).not.toHaveBeenCalled();
    });
  });

  it("GET /roles returns the role -> capability matrix", async () => {
    const { app } = buildApp({ role: "admin" });
    const res = await authedRequest(app).get("/organizations/roles");
    expect(res.status).toBe(200);
    expect(res.body.roles).toContain("admin");
    expect(res.body.roles).toContain("tester");
  });

  describe("cluster config (ADR 016 track A2)", () => {
    it("GET cluster returns metadata when configured", async () => {
      const { app, clusters } = buildApp({ role: "admin" });
      clusters.findMetadata.mockResolvedValue({
        id: "cluster_1",
        organizationId: ORG_ID,
        createdAt: "2026-08-30T00:00:00Z",
        updatedAt: "2026-08-30T00:00:00Z",
      } as never);
      const res = await authedRequest(app).get(`/organizations/${ORG_ID}/cluster`);
      expect(res.status).toBe(200);
      expect(res.body.cluster).toMatchObject({ id: "cluster_1" });
    });

    it("PUT cluster configures the org and marks it ready", async () => {
      const { app, organizations } = buildApp({ role: "admin" });
      organizations.findById.mockResolvedValue(makeOrg({ status: "pending_cluster" }) as never);
      const res = await authedRequest(app)
        .put(`/organizations/${ORG_ID}/cluster`)
        .send({ kubeconfig: "apiVersion: v1\nclusters: []" });
      expect(res.status).toBe(200);
      expect(organizations.setStatus).toHaveBeenCalledWith(ORG_ID, "ready");
    });

    it("403s cluster config for a non-admin", async () => {
      const { app, organizations } = buildApp({ role: "designer" });
      const res = await authedRequest(app)
        .put(`/organizations/${ORG_ID}/cluster`)
        .send({ kubeconfig: "apiVersion: v1" });
      expect(res.status).toBe(403);
      expect(organizations.setStatus).not.toHaveBeenCalled();
    });

    it("DELETE cluster clears config and reverts to pending_cluster", async () => {
      const { app, organizations } = buildApp({ role: "admin" });
      const res = await authedRequest(app).delete(`/organizations/${ORG_ID}/cluster`);
      expect(res.status).toBe(204);
      expect(organizations.setStatus).toHaveBeenCalledWith(ORG_ID, "pending_cluster");
    });
  });

  describe("org secrets (ADR 016 track A4)", () => {
    it("GET secrets lists org-level secret metadata", async () => {
      const { app, orgSecrets } = buildApp({ role: "admin" });
      orgSecrets.listForOrganization.mockResolvedValue([
        { id: "osec_1", key: "DATABASE_URL", createdAt: new Date(), updatedAt: new Date() },
      ] as never);
      const res = await authedRequest(app).get(`/organizations/${ORG_ID}/secrets`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("PUT secrets upserts an org-level secret (admin only)", async () => {
      const { app, orgSecrets } = buildApp({ role: "admin" });
      const res = await authedRequest(app)
        .put(`/organizations/${ORG_ID}/secrets`)
        .send({ key: "DATABASE_URL", value: "postgres://org" });
      expect(res.status).toBe(200);
      expect(orgSecrets.upsert).toHaveBeenCalledWith(ORG_ID, "DATABASE_URL", "postgres://org");
    });

    it("403s secret write for a non-admin", async () => {
      const { app, orgSecrets } = buildApp({ role: "developer" });
      const res = await authedRequest(app)
        .put(`/organizations/${ORG_ID}/secrets`)
        .send({ key: "K", value: "v" });
      expect(res.status).toBe(403);
      expect(orgSecrets.upsert).not.toHaveBeenCalled();
    });
  });

  describe("audit trail (ADR 028)", () => {
    it("records org.created with the creator as actor, scoped to the new org", async () => {
      const { app, audit } = buildApp({ role: "admin" });
      const res = await authedRequest(app)
        .post("/organizations")
        .send({ name: "Acme Retail" });
      expect(res.status).toBe(201);
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          organizationId: ORG_ID,
          actorUserId: USER_ID,
          action: "org.created",
        }),
      );
    });

    it("records org.role_changed against the target user, not the actor", async () => {
      const { app, audit } = buildApp({ role: "admin" });
      const res = await authedRequest(app)
        .patch(`/organizations/${ORG_ID}/members/${OTHER_USER_ID}`)
        .send({ role: "tester" });
      expect(res.status).toBe(200);
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          organizationId: ORG_ID,
          actorUserId: USER_ID,
          action: "org.role_changed",
          targetId: OTHER_USER_ID,
          metadata: { role: "tester" },
        }),
      );
    });

    it("records only the key name, never the value", async () => {
      const { app, audit } = buildApp({ role: "admin" });
      await authedRequest(app)
        .put(`/organizations/${ORG_ID}/secrets`)
        .send({ key: "DATABASE_URL", value: "postgres://leaked-value" });
      const [, input] = audit.record.mock.calls.at(-1) as [
        unknown,
        { metadata: Record<string, unknown> },
      ];
      expect(input.metadata).toEqual({ key: "DATABASE_URL" });
      expect(JSON.stringify(input.metadata)).not.toContain("leaked-value");
    });

    it("records nothing when the mutation is rejected", async () => {
      const { app, audit } = buildApp({ role: "developer" });
      const res = await authedRequest(app)
        .post(`/organizations/${ORG_ID}/invites`)
        .send({ role: "tester" });
      expect(res.status).toBe(403);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

/*
 * Issue #35: `GET /organizations/readiness` — the onboarding entry signal.
 *
 * Note what these assert beyond the shape: the route is **literal** (`/readiness`,
 * registered before `/:organizationId`), so the first case doubles as a guard
 * against the path being swallowed by the id route and 404ing on the UUID check —
 * a mistake that would silently break the Web gate while unit tests of the
 * predicate stayed green.
 */
describe("GET /organizations/readiness (issue #35)", () => {
  it("is reachable as a literal path, not parsed as an organization id", async () => {
    const { app } = buildApp({ role: "admin" });

    const res = await authedRequest(app).get("/organizations/readiness");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("entryAllowed");
  });

  it("allows entry and points at the org that satisfies it", async () => {
    const { app } = buildApp({ role: "admin", orgs: [makeOrg({ status: "ready" })] });

    const res = await authedRequest(app).get("/organizations/readiness");

    expect(res.body.entryAllowed).toBe(true);
    expect(res.body.readyOrganizationId).toBe(ORG_ID);
    expect(res.body.organizations[0].ready).toBe(true);
  });

  it("blocks entry and lists both outstanding steps on a fresh org", async () => {
    const { app } = buildApp({
      role: "admin",
      orgs: [makeOrg({ status: "pending_cluster", isPersonal: true })],
      jobDefaults: [],
    });

    const res = await authedRequest(app).get("/organizations/readiness");

    expect(res.body.entryAllowed).toBe(false);
    expect(res.body.readyOrganizationId).toBeNull();
    const steps = res.body.organizations[0].steps.filter(
      (step: { satisfied: boolean }) => !step.satisfied,
    );
    expect(steps.map((step: { id: string }) => step.id).sort()).toEqual([
      "cluster",
      "model_defaults",
    ]);
  });

  /*
   * The non-admin case, which is the issue's explicit requirement: the payload has
   * to carry enough for a client to say "an admin has to do this" instead of
   * rendering a form that member cannot submit.
   */
  it("carries the caller's role and that each step needs admin rights", async () => {
    const { app } = buildApp({
      role: "developer",
      orgs: [makeOrg({ status: "pending_cluster" })],
    });

    const res = await authedRequest(app).get("/organizations/readiness");

    expect(res.body.organizations[0].role).toBe("developer");
    expect(
      res.body.organizations[0].steps.every(
        (step: { requiresAdmin: boolean }) => step.requiresAdmin,
      ),
    ).toBe(true);
  });

  it("requires authentication", async () => {
    const { app } = buildApp({ role: "admin" });

    const res = await request(app).get("/organizations/readiness");

    expect(res.status).toBe(401);
  });
});
});
