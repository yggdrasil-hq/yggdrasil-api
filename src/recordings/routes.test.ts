import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createRecordingsRouter } from "./routes.js";
import type { JobRecording, JobRecordingContent } from "./types.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_JOB_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_COOKIE = "yggdrasil_session=sess_1";

const NOW = Date.now();

function makeRecording(overrides: Partial<JobRecording> = {}): JobRecording {
  return {
    jobId: JOB_ID,
    projectId: PROJECT_ID,
    contentType: "video/webm",
    byteSize: 4_200,
    expiresAt: new Date(NOW + 30 * 86_400_000),
    purgedAt: null,
    createdAt: new Date(NOW - 60_000),
    ...overrides,
  };
}

function buildApp(
  overrides: {
    /** Which project the caller is a member of; null means no access at all. */
    memberProjectId?: string | null;
    recording?: JobRecording | null;
    content?: JobRecordingContent | null;
    /** Whether the job resolves at all for this project. */
    jobFound?: boolean;
  } = {},
) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const memberProjectId =
    overrides.memberProjectId === undefined ? PROJECT_ID : overrides.memberProjectId;
  const jobFound = overrides.jobFound !== false;

  const users = { findById: vi.fn(async () => ({ id: USER_ID })) };
  const sessions = {
    findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID })),
    touch: vi.fn(async () => undefined),
  };
  const projects = {
    findByIdForUser: vi.fn(async (projectId: string) =>
      memberProjectId === projectId ? { id: projectId } : null,
    ),
  };
  const jobs = {
    findByIdForProject: vi.fn(async (_projectId: string, jobId: string) =>
      jobFound && jobId === JOB_ID ? { id: jobId, projectId: PROJECT_ID } : null,
    ),
  };
  const recordings = {
    findByJob: vi.fn(async () => overrides.recording ?? null),
    findContent: vi.fn(async () => overrides.content ?? null),
  };

  app.use(
    "/projects",
    createRecordingsRouter({
      users: users as never,
      sessions: sessions as never,
      projects: projects as never,
      jobs: jobs as never,
      recordings: recordings as never,
    }),
  );

  return { app, recordings, projects, jobs };
}

describe("GET /projects/:projectId/jobs/:jobId/recording (metadata)", () => {
  it("returns the recording with a server-computed state", async () => {
    const { app } = buildApp({ recording: makeRecording() });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.recording.state).toBe("available");
    expect(res.body.recording.byteSize).toBe(4_200);
    expect(res.body.recording.contentType).toBe("video/webm");
  });

  it("reports expired rather than 404 for a purged recording", async () => {
    // The distinction the whole feature turns on: an expired recording must be
    // tellable apart from one that never existed, so this is a 200 carrying
    // `expired`, not a 404.
    const { app } = buildApp({
      recording: makeRecording({ purgedAt: new Date(NOW), byteSize: 4_200 }),
    });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body.recording.state).toBe("expired");
    // Size survives the purge, which is what makes the UI able to say how large
    // the artifact was.
    expect(res.body.recording.byteSize).toBe(4_200);
  });

  it("reports expired once the window has closed, even unpurged", async () => {
    const { app } = buildApp({
      recording: makeRecording({ expiresAt: new Date(NOW - 1_000) }),
    });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.body.recording.state).toBe("expired");
  });

  it("answers null (not 404) when the run was never recorded", async () => {
    const { app } = buildApp({ recording: null });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recording: null });
  });

  it("404s for a job in another project", async () => {
    const { app } = buildApp({ recording: makeRecording() });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${OTHER_JOB_ID}/recording`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
  });

  it("404s when the caller is not a member of the project", async () => {
    const { app } = buildApp({ memberProjectId: OTHER_PROJECT_ID });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
  });

  it("401s without a session", async () => {
    const { app } = buildApp({ recording: makeRecording() });
    const res = await request(app).get(
      `/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording`,
    );
    expect(res.status).toBe(401);
  });

  it("404s on a malformed id without touching the database", async () => {
    const { app, recordings } = buildApp({ recording: makeRecording() });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/not-a-uuid/recording`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
    expect(recordings.findByJob).not.toHaveBeenCalled();
  });
});

describe("GET /projects/:projectId/jobs/:jobId/recording/content", () => {
  it("streams the bytes with a private, non-sniffable response", async () => {
    const data = Buffer.from("webm-bytes");
    const { app } = buildApp({
      content: { ...makeRecording(), data },
    });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording/content`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("video/webm");
    expect(res.headers["content-length"]).toBe(String(data.byteLength));
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // `private` is load-bearing: no shared proxy may cache what an authorized
    // browser fetched.
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.body).toEqual(data);
  });

  it("410s — not 404s — for a purged recording", async () => {
    // "Gone" rather than "missing": the artifact existed and is finished. A 404
    // is what would make an expired recording render as a broken link.
    const { app } = buildApp({
      content: {
        ...makeRecording({ purgedAt: new Date(NOW) }),
        data: null,
      },
    });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording/content`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/retention/i);
  });

  it("410s once past the expiry window even if bytes remain", async () => {
    // Belt and braces: the sweep is periodic, so there is a window in which an
    // expired recording still holds bytes. Serving it then would contradict the
    // metadata endpoint's own `expired`.
    const { app } = buildApp({
      content: {
        ...makeRecording({ expiresAt: new Date(NOW - 1_000) }),
        data: Buffer.from("stale"),
      },
    });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording/content`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(410);
  });

  it("404s when no recording was ever stored", async () => {
    const { app } = buildApp({ content: null });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording/content`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
  });

  it("404s for a job in another project", async () => {
    const { app } = buildApp({
      content: { ...makeRecording(), data: Buffer.from("x") },
    });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${OTHER_JOB_ID}/recording/content`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
  });

  it("404s when the caller is not a member of the project", async () => {
    const { app } = buildApp({
      memberProjectId: null,
      content: { ...makeRecording(), data: Buffer.from("x") },
    });
    const res = await request(app)
      .get(`/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording/content`)
      .set("Cookie", SESSION_COOKIE);

    expect(res.status).toBe(404);
  });

  it("401s without a session", async () => {
    const { app } = buildApp();
    const res = await request(app).get(
      `/projects/${PROJECT_ID}/jobs/${JOB_ID}/recording/content`,
    );
    expect(res.status).toBe(401);
  });
});
