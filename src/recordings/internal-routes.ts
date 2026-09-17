import { Router, raw } from "express";
import type express from "express";
import { config } from "../config.js";
import type { JobRepository } from "../jobs/repository.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { JobRecordingRepository } from "./repository.js";
import { formatByteSize, resolveExpiry, rejectUpload } from "./retention.js";
import { toPublicJobRecording } from "./types.js";

/**
 * ADR 029's upload endpoint: the Orchestrator posts the bytes it read out of a
 * job pod before the pod is deleted.
 *
 * Binary rather than JSON. The body is the video itself, read from the pod as
 * raw bytes (orchestrator/internal/k8s's exec reader), so wrapping it in a
 * JSON envelope would inflate it by a third in base64 for nothing — and the
 * app-wide `express.json` parser's 2 MB limit would reject most recordings
 * before this handler ever ran. `express.raw` is scoped to this one route for
 * the same reason: a 25 MB limit must not become the limit everywhere else.
 *
 * Not written to the audit trail, matching ADR 028 item 7's existing rule that
 * `/internal/*` Orchestrator-driven writes are out of scope — the API itself
 * orchestrated this run, and there is no human actor to attribute. The
 * deliberate exception ADR 022 carved out (a rollback) was a *destructive human
 * action*; storing an artifact a job produced is not.
 *
 * Never 500s on a rejected artifact. An oversized or unsupported recording gets
 * a 202 with the reason attached: the Orchestrator logs it and finishes the
 * job normally (ADR 029 item 5 — a recording must never fail a test run). A
 * 4xx here would tempt the caller into treating it as a job error.
 */
export function createRecordingsInternalRouter(deps: {
  jobs: JobRepository;
  recordings: JobRecordingRepository;
}): Router {
  const router = Router();

  router.post(
    "/jobs/:jobId/recording",
    requireInternalApiToken,
    raw({
      // Both accepted formats explicitly, so an unexpected Content-Type is not
      // silently parsed as one of them.
      type: ["video/webm", "video/mp4"],
      // Set to the real policy cap rather than some multiple of it, so an
      // arbitrarily large upload is rejected without ever being buffered. The
      // cost of that choice is that the parser, not this handler, is what
      // notices — handled by the error middleware below.
      limit: config.recordings.maxBytes,
    }),
    async (req, res) => {
      const jobId = routeParam(req.params.jobId);
      if (!isUuid(jobId)) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const job = await deps.jobs.findById(jobId);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      // Only the browser-driving job kinds record. `script_test_run` runs a
      // deterministic script with no browser, and every other kind has no test
      // session to film; a recording posted for one of them would be a
      // misconfiguration worth surfacing rather than storing.
      //
      // `feature_build` is included because its image ships Playwright too
      // (ADR 004) and a build's own verification step can legitimately record,
      // so refusing it would discard real artifacts. It is stored but not
      // surfaced anywhere yet — the run-history UI reads test runs.
      if (job.kind !== "test_run" && job.kind !== "feature_build") {
        res.status(202).json({ stored: false, reason: "This job kind does not record" });
        return;
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const contentType = (req.header("content-type") ?? "").split(";")[0]!.trim();

      const rejection = rejectUpload({
        contentType,
        byteSize: body.byteLength,
        maxBytes: config.recordings.maxBytes,
      });
      if (rejection) {
        res.status(202).json({ stored: false, reason: rejection });
        return;
      }

      // Anchored to the job's own start rather than to "now at upload time", so
      // a long run does not silently get a longer window than a short one, and
      // so a re-post of the same artifact cannot extend its own life.
      const createdAt = job.startedAt ?? job.createdAt;
      const expiresAt = resolveExpiry(createdAt, config.recordings.retentionDays);

      const recording = await deps.recordings.upsert({
        jobId: job.id,
        projectId: job.projectId,
        contentType: contentType as "video/webm" | "video/mp4",
        data: body,
        expiresAt,
      });

      res.status(201).json({
        stored: true,
        recording: toPublicJobRecording(recording, "available"),
      });
    },
  );

  /**
   * Turns the body parser's own rejection into the same non-fatal shape this
   * handler uses for every other refusal.
   *
   * This is load-bearing, not tidiness. `express.raw` aborts an over-limit body
   * with a 413 *before* the route handler runs, so without this the one case
   * that most needs the "never fails the job" contract would be the one case
   * that breaks it: the Orchestrator would see a 4xx, and an oversized
   * recording would surface as a failed run rather than a skipped artifact.
   * The true size is unknowable here (the body was aborted mid-stream), so the
   * reason names the configured limit instead.
   *
   * Anything that is not a body-parsing failure is passed straight through, so
   * a genuine error is never masked into a 2xx.
   */
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const status = (error as { status?: number; statusCode?: number } | null)
        ?.status ?? (error as { statusCode?: number } | null)?.statusCode;
      if (status === 413) {
        res.status(202).json({
          stored: false,
          reason: `Recording exceeds the ${formatByteSize(config.recordings.maxBytes)} limit`,
        });
        return;
      }
      next(error);
    },
  );

  return router;
}
