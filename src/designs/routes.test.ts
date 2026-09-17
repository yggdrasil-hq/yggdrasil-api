import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createDesignsRouter } from "./routes.js";
import type { Design } from "./types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const DESIGN_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_COOKIE = "yggdrasil_session=sess_1";

function makeDesign(overrides: Partial<Design> = {}): Design {
  return {
    id: DESIGN_ID,
    projectId: PROJECT_ID,
    name: "Checkout",
    slug: "checkout",
    status: "in_progress",
    originJobId: JOB_ID,
    prUrl: null,
    finalizedAt: null,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-02T10:00:00.000Z"),
    ...overrides,
  };
}

function buildApp(overrides: {
  /** Which project the caller is a member of; null means no access at all. */
  memberProjectId?: string | null;
  designs?: Array<{ design: Design; latestSession: unknown }>;
  design?: { design: Design; latestSession: unknown } | null;
} = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const memberProjectId =
    overrides.memberProjectId === undefined ? PROJECT_ID : overrides.memberProjectId;

  const users = { findById: vi.fn(async () => ({ id: USER_ID })) };
  const sessions = {
    findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID })),
    touch: vi.fn(async () => undefined),
  };
  const projects = {
    // Mirrors findByIdForUser: membership of the project is the whole gate.
    findByIdForUser: vi.fn(async (projectId: string) =>
      projectId === memberProjectId ? { id: projectId } : null,
    ),
  };
  const designs = {
    listForProject: vi.fn(async () => overrides.designs ?? []),
    findByIdForProject: vi.fn(async () => overrides.design ?? null),
    listSessions: vi.fn(async () => []),
  };

  app.use(
    "/projects",
    createDesignsRouter({
      users: users as never,
      sessions: sessions as never,
      projects: projects as never,
      designs: designs as never,
    }),
  );

  return { app, designs, projects };
}

describe("GET /projects/:projectId/designs", () => {
  it("lists a project's designs with the latest session folded in", async () => {
    const { app } = buildApp({
      designs: [
        {
          design: makeDesign(),
          latestSession: {
            id: JOB_ID,
            status: "failed",
            createdAt: new Date("2026-09-04T10:00:00.000Z"),
            completedAt: null,
            lastError: "container died",
          },
        },
      ],
    });

    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/designs`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.designs).toHaveLength(1);
    expect(res.body.designs[0]).toMatchObject({
      id: DESIGN_ID,
      slug: "checkout",
      status: "in_progress",
      prUrl: null,
      finalizedAt: null,
      latestSession: { id: JOB_ID, status: "failed", lastError: "container died" },
    });
    // Dates are serialized, not leaked as Date objects.
    expect(res.body.designs[0].createdAt).toBe("2026-09-01T10:00:00.000Z");
  });

  it("404s for a project the caller is not a member of", async () => {
    const { app, designs } = buildApp({ memberProjectId: OTHER_PROJECT_ID });

    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/designs`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
    // The gate runs before any read: no design data is even queried.
    expect(designs.listForProject).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid project id without querying", async () => {
    const { app, projects } = buildApp();

    const res = await request(app)
      .get("/projects/not-a-uuid/designs")
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
    expect(projects.findByIdForUser).not.toHaveBeenCalled();
  });
});

describe("GET /projects/:projectId/designs/:designId", () => {
  it("returns the design and its session history", async () => {
    const { app } = buildApp({
      design: { design: makeDesign({ status: "finalized", prUrl: "https://github.com/acme/web/pull/7" }), latestSession: null },
    });

    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/designs/${DESIGN_ID}`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.design).toMatchObject({
      id: DESIGN_ID,
      status: "finalized",
      prUrl: "https://github.com/acme/web/pull/7",
    });
    expect(res.body.sessions).toEqual([]);
  });

  it("does not leak another project's design", async () => {
    // The caller IS a member of OTHER_PROJECT_ID, and the design id is real —
    // but it belongs to PROJECT_ID, so scoping must 404 rather than resolve.
    const { app, designs } = buildApp({ memberProjectId: OTHER_PROJECT_ID });

    const res = await request(app)
      .get(`/projects/${OTHER_PROJECT_ID}/designs/${DESIGN_ID}`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
    expect(designs.findByIdForProject).toHaveBeenCalledWith(OTHER_PROJECT_ID, DESIGN_ID);
  });

  it("404s for a malformed design id without querying", async () => {
    const { app, designs } = buildApp();

    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/designs/not-a-uuid`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
    expect(designs.findByIdForProject).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const { app } = buildApp();

    const res = await request(app).get(`/projects/${PROJECT_ID}/designs/${DESIGN_ID}`);

    expect(res.status).toBe(401);
  });
});
