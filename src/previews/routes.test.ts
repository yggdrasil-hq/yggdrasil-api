import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createPreviewsRouter } from "./routes.js";
import type { JobPreview } from "./types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_COOKIE = "yggdrasil_session=sess_1";

function makePreview(overrides: Partial<JobPreview> = {}): JobPreview {
  return {
    id: "prev_1",
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    host: "acme-web-test-run-job-1.preview.yggdrasil.local",
    status: "active",
    lastError: null,
    createdAt: new Date("2026-09-17T10:00:00.000Z"),
    tornDownAt: null,
    ...overrides,
  };
}

function buildApp(overrides: {
  /** Which project the caller is a member of; null means no access at all. */
  memberProjectId?: string | null;
  previews?: JobPreview[];
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
  const previews = {
    listForProject: vi.fn(async () => overrides.previews ?? []),
  };

  app.use(
    "/projects",
    createPreviewsRouter({
      users: users as never,
      sessions: sessions as never,
      projects: projects as never,
      previews: previews as never,
    }),
  );

  return { app, previews };
}

function get(app: express.Express, projectId = PROJECT_ID) {
  return request(app).get(`/projects/${projectId}/previews`).set("Cookie", SESSION_COOKIE);
}

describe("GET /projects/:projectId/previews", () => {
  it("lists a project's previews with the host the Orchestrator reported", async () => {
    const { app } = buildApp({ previews: [makePreview()] });

    const res = await get(app);

    expect(res.status).toBe(200);
    expect(res.body.previews).toEqual([
      {
        jobId: JOB_ID,
        host: "acme-web-test-run-job-1.preview.yggdrasil.local",
        status: "active",
        lastError: null,
        createdAt: "2026-09-17T10:00:00.000Z",
        tornDownAt: null,
      },
    ]);
  });

  it("exposes teardown state so a dead preview can be distinguished from a live one", async () => {
    const { app } = buildApp({
      previews: [
        makePreview({
          status: "torn_down",
          tornDownAt: new Date("2026-09-17T11:00:00.000Z"),
        }),
      ],
    });

    const res = await get(app);

    expect(res.body.previews[0].status).toBe("torn_down");
    expect(res.body.previews[0].tornDownAt).toBe("2026-09-17T11:00:00.000Z");
  });

  it("surfaces a failed preview and its reason rather than hiding the job", async () => {
    const { app } = buildApp({
      previews: [
        makePreview({ status: "failed", lastError: "failed to ensure preview ingress" }),
      ],
    });

    const res = await get(app);

    expect(res.body.previews[0].status).toBe("failed");
    expect(res.body.previews[0].lastError).toBe("failed to ensure preview ingress");
  });

  // Membership of the project is the read gate, so another project's previews
  // — and the hosts they expose — cannot be enumerated by guessing an id.
  it("404s a project the caller is not a member of", async () => {
    const { app, previews } = buildApp({ memberProjectId: OTHER_PROJECT_ID });

    const res = await get(app);

    expect(res.status).toBe(404);
    expect(previews.listForProject).not.toHaveBeenCalled();
  });

  it("404s a non-uuid project id without querying", async () => {
    const { app, previews } = buildApp();

    const res = await get(app, "not-a-uuid");

    expect(res.status).toBe(404);
    expect(previews.listForProject).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const { app } = buildApp();

    const res = await request(app).get(`/projects/${PROJECT_ID}/previews`);

    expect(res.status).toBe(401);
  });

  it("returns an empty list for a project with no previews", async () => {
    const { app } = buildApp({ previews: [] });

    const res = await get(app);

    expect(res.status).toBe(200);
    expect(res.body.previews).toEqual([]);
  });
});
