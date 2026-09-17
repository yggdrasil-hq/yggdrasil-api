import { Router } from "express";
import { z } from "zod";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectDeployRepository } from "./repository.js";

const deployResultSchema = z.object({
  /**
   * The Helm revision the operation produced. 0 (or absent) means it produced
   * none — the Orchestrator reports a failed attempt that way, and the ledger
   * stores NULL so it can never be mistaken for a rollback target.
   */
  revision: z.number().int().nonnegative().default(0),
  /** Set only for a rollback job: the earlier revision that was requested. */
  targetRevision: z.number().int().positive().optional(),
  lastError: z.string().optional(),
});

/**
 * ADR 022: the Orchestrator's deploy/rollback completion report.
 *
 * This is the write half of the deploy ledger. It is a separate endpoint from
 * the job-events stream because a deploy is not agent-driven and carries no
 * curated event vocabulary — it has exactly one terminal fact to report (which
 * revision it produced), which the `jobs` row cannot express.
 *
 * The ledger row is derived from the *job* row rather than trusted from the
 * request body: project, kind and git ref all come from the job the API itself
 * enqueued, so a compromised or buggy caller cannot attribute a deploy to
 * another project. Only the outcome fields come from the body.
 */
export function createDeploysInternalRouter(deps: {
  deploys: ProjectDeployRepository;
  jobs: JobRepository;
}): Router {
  const router = Router();

  router.post(
    "/jobs/:jobId/deploy-result",
    requireInternalApiToken,
    async (req, res) => {
      const jobId = routeParam(req.params.jobId);
      if (!isUuid(jobId)) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const parsed = deployResultSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid deploy result payload" });
        return;
      }

      const job = await deps.jobs.findById(jobId);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (job.kind !== "deploy" && job.kind !== "rollback") {
        res.status(400).json({ error: `Job ${jobId} is not a deploy or rollback` });
        return;
      }

      const failed = parsed.data.lastError !== undefined && parsed.data.lastError !== "";
      await deps.deploys.record({
        projectId: job.projectId,
        jobId: job.id,
        kind: job.kind,
        // A failed attempt produced nothing to roll back to, so the revision is
        // dropped rather than recorded as 0 — see the schema comment.
        helmRevision: failed || parsed.data.revision === 0 ? null : parsed.data.revision,
        targetRevision: parsed.data.targetRevision ?? null,
        status: failed ? "failed" : "completed",
        lastError: failed ? parsed.data.lastError : null,
        ref: job.ref,
      });

      res.status(201).json({});
    },
  );

  return router;
}
