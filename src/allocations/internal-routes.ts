import { Router } from "express";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { AllocationRepository } from "./repository.js";
import { evaluateTokenCap, monthPeriod } from "./evaluate.js";
import { DEFAULT_RESOURCE_QUOTA, consumesTokens } from "./types.js";
import type { JobKind } from "../jobs/types.js";

/**
 * ADR 030 §4: the enforcement contract the Orchestrator consumes.
 *
 * The API is the authority for both halves of a cap decision -- the stored cap
 * *and* the consumption it is compared against -- so the Orchestrator never
 * needs to know the period semantics, the table names, or which job kinds
 * consume tokens. It asks one question about one job and gets one answer.
 *
 * That split is deliberate: a second, Orchestrator-side copy of "what does
 * over-cap mean" is exactly the kind of duplicated rule that drifts, and this
 * one governs spend.
 */
export function createAllocationsInternalRouter(deps: {
  projects: ProjectRepository;
  allocations: AllocationRepository;
}): Router {
  const router = Router();

  /**
   * Whether a job of this kind may run for this project right now.
   *
   * Returns 200 with a decision body rather than a 4xx for "no": being over
   * cap is a normal, expected answer to a legitimate question, not a client
   * error, and the Orchestrator needs the detail to write a legible
   * `last_error`.
   */
  router.get(
    "/projects/:projectId/token-cap",
    requireInternalApiToken,
    async (req, res) => {
      const projectId = routeParam(req.params.projectId);
      if (!isUuid(projectId)) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const project = await deps.projects.findById(projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      // Express types a query value as possibly-array/possibly-absent; a
      // repeated `?kind=` is meaningless here, so anything but a single string
      // reads as "unspecified", which is then treated as non-token-consuming
      // (fail-open on a value the caller did not actually assert).
      const rawKind = req.query.kind;
      const kindParam = typeof rawKind === "string" ? rawKind : "";
      const kind = kindParam as JobKind;
      // A job kind that spends nothing is never blocked by a spend cap. The
      // caller still gets the cap state -- it is useful context -- but `allowed`
      // is what it acts on.
      const spends = consumesTokens(kind);

      const stored = await deps.allocations.findTokenCap(projectId);
      const { start, end } = monthPeriod(new Date());
      const usedTokens = await deps.allocations.tokensUsedInPeriod(projectId, start, end);
      const state = evaluateTokenCap({
        projectId,
        cap: stored?.monthlyTokenCap ?? null,
        usedTokens,
        now: new Date(),
      });

      res.json({
        ...state,
        consumesTokens: spends,
        allowed: !spends || !state.exceeded,
      });
    },
  );

  /**
   * The effective ResourceQuota for a project's namespace (ADR 003 §17).
   *
   * Always returns concrete numbers: the stored override where one exists, the
   * platform default otherwise, so the Orchestrator applies exactly what the
   * admin sees on /allocations/infra without carrying a second set of defaults
   * that could disagree with it.
   */
  router.get(
    "/projects/:projectId/resource-quota",
    requireInternalApiToken,
    async (req, res) => {
      const projectId = routeParam(req.params.projectId);
      if (!isUuid(projectId)) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const project = await deps.projects.findById(projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const stored = await deps.allocations.findResourceQuota(projectId);
      res.json({
        projectId,
        cpuMillicores: stored?.cpuMillicores ?? DEFAULT_RESOURCE_QUOTA.cpuMillicores,
        memoryMib: stored?.memoryMib ?? DEFAULT_RESOURCE_QUOTA.memoryMib,
        pods: stored?.pods ?? DEFAULT_RESOURCE_QUOTA.pods,
        fromOverride: stored !== null,
      });
    },
  );

  return router;
}
