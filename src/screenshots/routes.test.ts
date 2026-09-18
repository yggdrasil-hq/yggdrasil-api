import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import "../shared/async-handlers.js";
import { createScreenshotsRouter } from "./routes.js";
import type { JobScreenshot, JobScreenshotContent } from "./types.js";

/**
 * Issue #22's read side.
 *
 * The properties worth pinning are the ones a caller cannot see from the happy
 * path: that another project's artifacts are a 404 rather than readable, and
 * that a *purged* screenshot answers 410 rather than 404 — because conflating
 * "reclaimed" with "never existed" is what renders an expired artifact as a
 * broken image with no explanation.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_JOB_ID = "33333333-3333-4333-8333-333333333333";
const SCREENSHOT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_COOKIE = "yggdrasil_session=sess_1";

const NOW = Date.now();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeScreenshot(overrides: Partial<JobScreenshot> = {}): JobScreenshot {
  return {
    id: SCREENSHOT_ID,
    jobId: JOB_ID,
    projectId: PROJECT_ID,
    stepName: "Opens the cart",
    contentType: "image/png",
    byteSize: PNG.byteLength,
    expiresAt: new Date(NOW + 30 * 86_400_000),
    purgedAt: null,
    createdAt: new Date(NOW - 60_000),
    ...overrides,
  };
}

function buildApp(
  overrides: {
    memberProjectId?: string | null;
    jobFound?: boolean;
    screenshots?: JobScreenshot[];
    content?: JobScreenshotContent | null;
  } = {},
) {
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
    findByIdForUser: vi.fn(async (projectId: string) =>
      memberProjectId === projectId ? { id: projectId } : null,
    ),
  };
  const jobs = {
    findByIdForProject: vi.fn(async (_projectId: string, jobId: string) =>
      overrides.jobFound !== false && jobId === JOB_ID
        ? { id: jobId, projectId: PROJECT_ID }
        : null,
    ),
  };
  const screenshots = {
    listForJob: vi.fn(async () => overrides.screenshots ?? []),
    findByIdForJob: vi.fn(async () => overrides.screenshots?.[0] ?? null),
    findContent: vi.fn(async () => overrides.content ?? null),
  };

  app.use(
    "/projects",
    createScreenshotsRouter({ users, sessions, projects, jobs, screenshots } as never),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void error;
      res.status(500).json({ error: "Internal server error" });
    },
  );

  return { app, screenshots };
}

function authed(app: express.Express, path: string) {
  return request(app).get(path).set("Cookie", SESSION_COOKIE);
}

describe("GET /projects/:projectId/jobs/:jobId/screenshots", () => {
  it("lists a run's screenshots with server-computed state", async () => {
    const { app } = buildApp({
      screenshots: [
        makeScreenshot(),
        makeScreenshot({
          id: "66666666-6666-4666-8666-666666666666",
          stepName: "Pays",
          createdAt: new Date(NOW - 30_000),
        }),
      ],
    });

    const res = await authed(app, `/projects/${PROJECT_ID}/jobs/${JOB_ID}/screenshots`);

    expect(res.status).toBe(200);
    expect(res.body.screenshots).toHaveLength(2);
    expect(res.body.screenshots[0]).toMatchObject({
      id: SCREENSHOT_ID,
      stepName: "Opens the cart",
      state: "available",
      contentType: "image/png",
    });
    // No bytes in the listing, by design: a run-history response must never
    // balloon to the size of the images it describes.
    expect(res.body.screenshots[0]).not.toHaveProperty("data");
  });

  it("reports a purged screenshot as expired rather than omitting it", async () => {
    // The whole reason the sweeper tombstones instead of deleting. A step that
    // had a screenshot must keep saying so, or the UI shows nothing where an
    // artifact existed and the user concludes the feature is broken.
    const { app } = buildApp({
      screenshots: [makeScreenshot({ purgedAt: new Date(NOW - 1_000), expiresAt: new Date(NOW - 1) })],
    });

    const res = await authed(app, `/projects/${PROJECT_ID}/jobs/${JOB_ID}/screenshots`);

    expect(res.body.screenshots).toHaveLength(1);
    expect(res.body.screenshots[0].state).toBe("expired");
  });

  it("answers 200 with an empty list for a run that captured none", async () => {
    // A normal answer the UI renders, not an error.
    const { app } = buildApp({ screenshots: [] });

    const res = await authed(app, `/projects/${PROJECT_ID}/jobs/${JOB_ID}/screenshots`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ screenshots: [] });
  });

  it("404s for a project the caller cannot read", async () => {
    const { app, screenshots } = buildApp({ memberProjectId: null });

    const res = await authed(app, `/projects/${PROJECT_ID}/jobs/${JOB_ID}/screenshots`);

    // One 404 for every reason a job is unreadable, so this route cannot be used
    // to probe which job ids exist.
    expect(res.status).toBe(404);
    expect(screenshots.listForJob).not.toHaveBeenCalled();
  });

  it("404s for an unknown job", async () => {
    const { app } = buildApp({ jobFound: false });
    expect((await authed(app, `/projects/${PROJECT_ID}/jobs/${JOB_ID}/screenshots`)).status).toBe(
      404,
    );
  });

  it("404s for a malformed job id", async () => {
    const { app } = buildApp();
    expect(
      (await authed(app, `/projects/${PROJECT_ID}/jobs/${OTHER_JOB_ID}/screenshots`)).status,
    ).toBe(404);
  });
});

describe("GET /projects/:projectId/jobs/:jobId/screenshots/:screenshotId/content", () => {
  const contentUrl = `/projects/${PROJECT_ID}/jobs/${JOB_ID}/screenshots/${SCREENSHOT_ID}/content`;

  it("serves the bytes with the stored content type and no-sniff", async () => {
    const { app } = buildApp({
      content: { ...makeScreenshot(), data: PNG },
    });

    const res = await authed(app, contentUrl);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    // `private` is the load-bearing word: no shared proxy may cache a screenshot
    // of a session an authorized browser just fetched.
    expect(res.headers["cache-control"]).toContain("private");
    expect(res.headers["content-disposition"]).toBe("inline");
    expect(res.body.equals(PNG)).toBe(true);
  });

  it("answers 410 — not 404 — for a screenshot whose bytes were reclaimed", async () => {
    // The distinction the whole tombstone design exists for. A client that
    // conflates the two renders an expired artifact as a broken image.
    const { app } = buildApp({
      content: {
        ...makeScreenshot({ purgedAt: new Date(NOW - 1_000), expiresAt: new Date(NOW - 1) }),
        data: null,
      },
    });

    const res = await authed(app, contentUrl);

    expect(res.status).toBe(410);
    expect(res.body.error).toContain("retention");
  });

  it("answers 410 for a row that is past expiry but not yet swept", async () => {
    // The sweep runs on an interval, so there is a window where the bytes are
    // still present but the artifact is past its window. The state function is
    // the authority in that window, not the presence of bytes — otherwise an
    // artifact would be readable for up to one sweep interval after it expired,
    // and the retention policy would be a lie of up to that much.
    const { app } = buildApp({
      content: { ...makeScreenshot({ expiresAt: new Date(NOW - 1) }), data: PNG },
    });

    expect((await authed(app, contentUrl)).status).toBe(410);
  });

  it("answers 404 for a screenshot that was never captured", async () => {
    const { app } = buildApp({ content: null });
    expect((await authed(app, contentUrl)).status).toBe(404);
  });

  it("answers 404 for a malformed screenshot id", async () => {
    const { app } = buildApp();
    const res = await authed(
      app,
      `/projects/${PROJECT_ID}/jobs/${JOB_ID}/screenshots/not-a-uuid/content`,
    );
    expect(res.status).toBe(404);
  });

  it("answers 404 for another project's job", async () => {
    const { app, screenshots } = buildApp({ memberProjectId: null });

    expect((await authed(app, contentUrl)).status).toBe(404);
    expect(screenshots.findContent).not.toHaveBeenCalled();
  });
});
