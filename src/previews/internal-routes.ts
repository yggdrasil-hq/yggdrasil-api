import { Router } from "express";
import { z } from "zod";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { JobRepository } from "../jobs/repository.js";
import type { JobPreviewRepository } from "./repository.js";
import { toPublicJobPreview } from "./types.js";

const registerSchema = z.object({
  /** Bare hostname, computed by the Orchestrator (internal/preview). */
  host: z.string().trim().min(1),
  /**
   * Set when the preview could not be brought up. Mirrors the deploy-result
   * endpoint's `lastError` convention: presence means failure, so a caller
   * cannot register an active preview that silently failed.
   */
  error: z.string().optional(),
});

/**
 * ADR 003 §15/§17: the Orchestrator's preview registry callbacks.
 *
 * Internal-only, like every other `/internal/*` route, and for the same
 * reason: these are machine-to-machine facts about what the Orchestrator did
 * to the cluster, not user actions. ADR 028 keeps `/internal/*` writes out of
 * the audit trail, so nothing here records an audit event — previews are
 * created and destroyed as a side effect of running a job, and the job row
 * plus this registry already say so.
 *
 * Project and kind are derived from the *job* row rather than taken from the
 * request body, exactly as the deploy-result endpoint does: a compromised or
 * buggy caller then cannot attribute a preview to another project, or name a
 * job kind that is not actually eligible for one.
 */
export function createPreviewsInternalRouter(deps: {
  previews: JobPreviewRepository;
  jobs: JobRepository;
}): Router {
  const router = Router();

  router.post("/jobs/:jobId/preview", requireInternalApiToken, async (req, res) => {
    const jobId = routeParam(req.params.jobId);
    if (!isUuid(jobId)) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid preview payload" });
      return;
    }

    const job = await deps.jobs.findById(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const failed = parsed.data.error !== undefined && parsed.data.error !== "";
    const preview = failed
      ? await deps.previews.markFailed({
          projectId: job.projectId,
          jobId: job.id,
          host: parsed.data.host,
          lastError: parsed.data.error!,
        })
      : await deps.previews.register({
          projectId: job.projectId,
          jobId: job.id,
          host: parsed.data.host,
        });

    res.status(201).json({ preview: toPublicJobPreview(preview) });
  });

  /**
   * Frees a preview's ADR 003 §17 slot. Idempotent by design: the job's own
   * deferred teardown and the stale sweep can both report the same preview,
   * and the loser must not be an error. Reports success when there is no row
   * at all — a job that failed before its preview ever came up has nothing to
   * tear down, which is not a failure.
   */
  router.post("/jobs/:jobId/preview/teardown", requireInternalApiToken, async (req, res) => {
    const jobId = routeParam(req.params.jobId);
    if (!isUuid(jobId)) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const preview = await deps.previews.markTornDown(jobId);
    res.json({ preview: preview ? toPublicJobPreview(preview) : null });
  });

  /**
   * The stale-preview sweep's work list. The API computes staleness because it
   * is the side that can see both the preview row and its job's status; the
   * Orchestrator is the side that can actually delete the cluster resources.
   *
   * `ttlSeconds` bounds how long a preview may outlive its job even when
   * nothing else knows the job is gone — a hard-crashed job stays 'running'
   * forever, so job status alone cannot collect its preview.
   */
  router.get("/previews/stale", requireInternalApiToken, async (req, res) => {
    const ttlSeconds = parseBoundedInt(req.query.ttlSeconds, 7200, 60, 86_400);
    const limit = parseBoundedInt(req.query.limit, 100, 1, 500);

    const stale = await deps.previews.listStale({ ttlSeconds, limit });
    res.json({ previews: stale });
  });

  return router;
}

/**
 * Reads a positive integer query param, falling back to `fallback` and
 * clamping to [min, max]. A bad value is treated as absent rather than a 400:
 * this endpoint is polled by a background sweep, and failing the whole call
 * over one malformed query would stall cleanup instead of bounding it.
 */
function parseBoundedInt(raw: unknown, fallback: number, min: number, max: number): number {
  const value = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}
