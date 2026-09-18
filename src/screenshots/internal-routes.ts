import { Router, raw } from "express";
import type express from "express";
import { config } from "../config.js";
import type { JobRepository } from "../jobs/repository.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import { resolveExpiry } from "../shared/artifacts.js";
import {
  normalizeStepName,
  rejectScreenshotUpload,
  type ScreenshotContentType,
} from "./retention.js";
import type { JobScreenshotRepository } from "./repository.js";
import { toPublicJobScreenshot } from "./types.js";

/**
 * Issue #22's upload endpoint: the Orchestrator posts the bytes it read out of a
 * job pod before the pod is deleted, symmetrically with
 * `POST /internal/jobs/:jobId/recording` (ADR 029).
 *
 * Binary rather than JSON, for the reason the recording endpoint documents: the
 * body is the image itself, so a JSON envelope would inflate it by a third in
 * base64 for nothing, and the app-wide `express.json` parser's 2 MB limit would
 * reject the larger screenshots before this handler ever ran. `express.raw` is
 * scoped to this route for the same reason.
 *
 * **Why a query parameter carries the step name.** A step name is a `##` heading
 * from the project's own test markdown: arbitrary text, potentially long, and
 * requiring URL encoding that a path segment makes awkward to get right for
 * every case. A query parameter is also visible in logs and reproducible with
 * `curl`, which matters for an endpoint whose only caller is a Go binary in
 * another repo. The *read* side addresses a screenshot by its `id` instead, so
 * no step name ever has to appear in a URL a browser builds.
 *
 * Never 500s on a rejected artifact, matching the recording endpoint: an
 * oversized, unsupported or over-quota screenshot gets a 202 with the reason
 * attached, because a 4xx here would tempt the caller into treating a diagnostic
 * artifact as a job error. ADR 029 item 5's rule — an artifact must never fail
 * the run that produced it — applies unchanged.
 *
 * Not written to the audit trail, matching ADR 028 item 7's existing rule that
 * `/internal/*` Orchestrator-driven writes are out of scope: there is no human
 * actor to attribute, and storing an artifact a run produced is not the
 * destructive-action exception ADR 022 carved out for rollback.
 */
export function createScreenshotsInternalRouter(deps: {
  jobs: JobRepository;
  screenshots: JobScreenshotRepository;
}): Router {
  const router = Router();

  router.post(
    "/jobs/:jobId/screenshot",
    requireInternalApiToken,
    raw({
      // The accepted formats explicitly, so an unexpected Content-Type is not
      // silently parsed as one of them. SVG is absent on purpose — see
      // `SCREENSHOT_CONTENT_TYPES`.
      type: [...config.screenshots.contentTypes],
      limit: config.screenshots.maxBytes,
    }),
    async (req, res) => {
      const jobId = routeParam(req.params.jobId);
      if (!isUuid(jobId)) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const stepName = normalizeStepName(req.query.stepName);
      if (!stepName) {
        res.status(400).json({
          error:
            `A stepName query parameter is required and must be 1-${256} characters after trimming`,
        });
        return;
      }

      const job = await deps.jobs.findById(jobId);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      // Only the kinds whose tests report steps can have step screenshots.
      // `report_test_step` is accepted for `test_run` only (see the events
      // route), and `feature_build`'s own verification step can legitimately
      // produce one too — ADR 029 includes `feature_build` for recordings for
      // exactly this reason. Every other kind would be a misconfiguration worth
      // surfacing rather than storing.
      if (job.kind !== "test_run" && job.kind !== "feature_build") {
        res.status(202).json({ stored: false, reason: "This job kind does not report steps" });
        return;
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const contentType = (req.header("content-type") ?? "").split(";")[0]!.trim();

      const rejection = rejectScreenshotUpload({
        contentType,
        byteSize: body.byteLength,
        maxBytes: config.screenshots.maxBytes,
        screenshotsForJob: await deps.screenshots.countForJob(job.id),
        maxPerJob: config.screenshots.maxPerJob,
      });
      if (rejection) {
        res.status(202).json({ stored: false, reason: rejection });
        return;
      }

      // Anchored to the job's own start rather than to "now at upload time", so
      // a long run does not silently get a longer window than a short one, and
      // so a re-post of the same artifact cannot extend its own life. The same
      // rule as the recording endpoint.
      const createdAt = job.startedAt ?? job.createdAt;
      const expiresAt = resolveExpiry(createdAt, config.screenshots.retentionDays);

      const screenshot = await deps.screenshots.upsert({
        jobId: job.id,
        projectId: job.projectId,
        stepName,
        contentType: contentType as ScreenshotContentType,
        data: body,
        expiresAt,
      });

      res.status(201).json({
        stored: true,
        screenshot: toPublicJobScreenshot(screenshot, "available"),
      });
    },
  );

  /**
   * Turns the body parser's own rejection into the same non-fatal shape this
   * handler uses for every other refusal.
   *
   * This is load-bearing rather than tidiness, and it is the reason the
   * recording endpoint has an identical handler: `express.raw` aborts an
   * over-limit body with a 413 *before* the route handler runs, so without this
   * the one case that most needs the "never fails the job" contract would be the
   * one case that breaks it. The true size is unknowable here (the body was
   * aborted mid-stream), so the reason names the configured limit instead.
   *
   * Anything that is not a body-parsing failure passes straight through, so a
   * genuine error is never masked into a 2xx.
   */
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const status =
        (error as { status?: number; statusCode?: number } | null)?.status ??
        (error as { statusCode?: number } | null)?.statusCode;
      if (status === 413) {
        res.status(202).json({
          stored: false,
          reason: `Screenshot exceeds the ${config.screenshots.maxBytes} byte limit`,
        });
        return;
      }
      next(error);
    },
  );

  return router;
}
