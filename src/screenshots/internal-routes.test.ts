import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
// Issue #45: Express 4 does not catch a rejected promise from an async handler,
// so a test app that builds its own router must import the patch the real app
// does or a genuine error hangs the request instead of answering.
import "../shared/async-handlers.js";
import { createScreenshotsInternalRouter } from "./internal-routes.js";
import type { Job } from "../jobs/types.js";

/**
 * Issue #22's upload contract. Exercised through the real route with a binary
 * body, because the two things most likely to break are the body parser's
 * configuration (a Content-Type the parser does not accept never reaches the
 * handler) and the error middleware that turns its 413 into a 202 — neither of
 * which a unit test of the handler could see.
 */

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const INTERNAL_TOKEN = "test-internal-api-token";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    projectId: PROJECT_ID,
    kind: "test_run",
    featureId: null,
    testId: null,
    testGroup: null,
    ref: null,
    trigger: null,
    designName: null,
    designSlug: null,
    designDescription: null,
    designId: null,
    specContext: null,
    status: "running",
    lastError: null,
    createdAt: new Date(),
    startedAt: new Date("2026-09-18T10:00:00.000Z"),
    completedAt: null,
    targetRevision: null,
    restartedFromEventId: null,
    ...overrides,
  };
}

function buildApp(overrides: { job?: Job | null; screenshotCount?: number } = {}) {
  const app = express();

  const jobs = {
    findById: vi.fn(async () => (overrides.job === undefined ? makeJob() : overrides.job)),
  };
  const screenshots = {
    countForJob: vi.fn(async () => overrides.screenshotCount ?? 0),
    upsert: vi.fn(async (input: Record<string, unknown>) => ({
      id: "33333333-3333-4333-8333-333333333333",
      purgedAt: null,
      createdAt: new Date("2026-09-18T10:05:00.000Z"),
      ...input,
    })),
  };

  app.use("/internal", createScreenshotsInternalRouter({ jobs, screenshots } as never));
  // The app-level handler the real app installs, so "not masked into a 2xx" is
  // observable as a concrete status rather than as a hang.
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
  return { app, jobs, screenshots };
}

function upload(
  app: express.Express,
  options: { stepName?: string | null; contentType?: string; body?: Buffer; jobId?: string } = {},
) {
  const query = options.stepName === undefined ? "Opens the cart" : options.stepName;
  const url = `/internal/jobs/${options.jobId ?? JOB_ID}/screenshot${
    query === null ? "" : `?stepName=${encodeURIComponent(query)}`
  }`;
  let req = request(app)
    .post(url)
    .set("Authorization", `Bearer ${INTERNAL_TOKEN}`)
    .set("Content-Type", options.contentType ?? "image/png");
  if (options.contentType !== "text/plain") {
    req = req.set("Content-Length", String((options.body ?? PNG_BYTES).byteLength));
  }
  return req.send(options.body ?? PNG_BYTES);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /internal/jobs/:jobId/screenshot", () => {
  it("stores a screenshot against its step and returns its metadata", async () => {
    const { app, screenshots } = buildApp();

    const res = await upload(app);

    expect(res.status).toBe(201);
    expect(res.body.stored).toBe(true);
    // Addressed by id, not by step name: that is what the read side fetches bytes
    // with, so a step name never has to appear in a URL a browser builds.
    expect(res.body.screenshot.stepName).toBe("Opens the cart");
    expect(res.body.screenshot.id).toBeTruthy();
    expect(screenshots.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: JOB_ID,
        // From the job row, never from the request: a caller cannot attribute an
        // artifact to a project it does not belong to.
        projectId: PROJECT_ID,
        stepName: "Opens the cart",
        contentType: "image/png",
      }),
    );
  });

  it("derives the expiry from the job's own start, not from upload time", async () => {
    // So a long run does not silently get a longer window than a short one, and a
    // re-post of the same artifact cannot extend its own life.
    const { app, screenshots } = buildApp();
    await upload(app);

    const expiresAt = (screenshots.upsert.mock.calls[0]![0] as { expiresAt: Date }).expiresAt;
    const expected = new Date("2026-09-18T10:00:00.000Z").getTime() + 30 * 86_400_000;
    expect(expiresAt.getTime()).toBe(expected);
  });

  it("trims the step name before storing it", async () => {
    const { app, screenshots } = buildApp();
    await upload(app, { stepName: "   Padded step   " });

    expect(screenshots.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ stepName: "Padded step" }),
    );
  });

  it("400s without a step name, because the artifact has no key without one", async () => {
    const { app, screenshots } = buildApp();

    const res = await upload(app, { stepName: null });

    expect(res.status).toBe(400);
    expect(screenshots.upsert).not.toHaveBeenCalled();
  });

  it("400s for a whitespace-only step name", async () => {
    const { app, screenshots } = buildApp();
    expect((await upload(app, { stepName: "   " })).status).toBe(400);
    expect(screenshots.upsert).not.toHaveBeenCalled();
  });

  it("404s for an unknown job", async () => {
    const { app, screenshots } = buildApp({ job: null });
    expect((await upload(app)).status).toBe(404);
    expect(screenshots.upsert).not.toHaveBeenCalled();
  });

  it("404s for a malformed job id", async () => {
    const { app } = buildApp();
    expect((await upload(app, { jobId: "not-a-uuid" })).status).toBe(404);
  });

  it("refuses an unexpected Content-Type without storing it", async () => {
    // `express.raw` is configured with the accepted image types explicitly, so a
    // body it does not recognise never reaches the handler. The request must not
    // 500 either — the caller is a Go binary that treats a 4xx as a job error.
    const { app, screenshots } = buildApp();

    const res = await upload(app, { contentType: "text/plain", body: Buffer.from("nope") });

    expect(res.status).toBe(202);
    expect(res.body.stored).toBe(false);
    expect(screenshots.upsert).not.toHaveBeenCalled();
  });

  it("202s rather than failing when the run is at its screenshot quota", async () => {
    // ADR 029 item 5's rule, applied to the second artifact family: an artifact
    // must never fail the run that produced it. A 4xx here would tempt the
    // orchestrator into treating a full quota as a job error.
    const { app, screenshots } = buildApp({ screenshotCount: 50 });

    const res = await upload(app);

    expect(res.status).toBe(202);
    expect(res.body.stored).toBe(false);
    expect(res.body.reason).toContain("maximum of 50 screenshots");
    expect(screenshots.upsert).not.toHaveBeenCalled();
  });

  it("202s for a job kind that does not report steps", async () => {
    const { app, screenshots } = buildApp({ job: makeJob({ kind: "deploy" }) });

    const res = await upload(app);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ stored: false, reason: "This job kind does not report steps" });
    expect(screenshots.upsert).not.toHaveBeenCalled();
  });

  it("accepts a feature_build, whose verification step can also screenshot", async () => {
    // ADR 029 includes feature_build for recordings for the same reason: its
    // image ships Playwright, so refusing would discard real artifacts.
    const { app } = buildApp({ job: makeJob({ kind: "feature_build" }) });
    expect((await upload(app)).status).toBe(201);
  });

  it("requires the internal bearer token", async () => {
    const { app, screenshots } = buildApp();

    const res = await request(app)
      .post(`/internal/jobs/${JOB_ID}/screenshot?stepName=step`)
      .set("Content-Type", "image/png")
      .send(PNG_BYTES);

    expect(res.status).toBe(401);
    expect(screenshots.upsert).not.toHaveBeenCalled();
  });

  it("turns the body parser's 413 into the same non-fatal 202 shape", async () => {
    // The load-bearing case, and the reason this handler exists at all: an
    // over-limit body is aborted by `express.raw` *before* the route handler runs,
    // so without the error middleware the one refusal that most needs the
    // "never fails the job" contract would be the one that breaks it.
    const { app, screenshots } = buildApp();

    const oversized = Buffer.alloc(2_000_001, 1);
    const res = await upload(app, { body: oversized });

    expect(res.status).toBe(202);
    expect(res.body.stored).toBe(false);
    expect(res.body.reason).toContain("limit");
    expect(screenshots.upsert).not.toHaveBeenCalled();
  });

  it("does not mask a genuine error into a 2xx", async () => {
    const { app, screenshots } = buildApp();
    screenshots.upsert.mockRejectedValueOnce(new Error("connection terminated"));

    const res = await upload(app);

    // The route's own error middleware calls `next()` for anything that is not a
    // body-parser 413, so a storage failure surfaces as a 500 rather than being
    // swallowed into the friendly 202 shape the refusals use.
    expect(res.status).toBe(500);
  });
});
