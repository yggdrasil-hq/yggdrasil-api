import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import type { AuditRecorder } from "../audit/record.js";
import { AUDIT_ACTIONS } from "../audit/actions.js";
import type { OrganizationRepository } from "../organizations/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { UserRepository } from "../users/repository.js";
import type { AllocationRepository } from "./repository.js";
import { evaluateTokenCap, monthPeriod } from "./evaluate.js";
import {
  DEFAULT_RESOURCE_QUOTA,
  toEffectiveAllocation,
  type OrganizationAllocationsResponse,
} from "./types.js";

/**
 * ADR 030: the org-admin surface for per-project allocation caps.
 *
 * Two independent caps live behind one page in the product (design/allocations/
 * api and infra render them side by side), so they share one read here rather
 * than two round trips that could disagree about the period.
 *
 * Authorization split, deliberately not uniform:
 *   - **Writing** a cap is admin-only, matching every other org-settings
 *     surface (ADR 016/018).
 *   - **Reading** is open to any member of the organization. A cap is not a
 *     credential -- it is the operational fact that explains why a project's
 *     work stopped, and hiding it from the developer who is blocked turns a
 *     clear "you are over cap" into an unexplained failure. This is why the
 *     design note's "org-admin-only" is only followed for writes.
 */
export function createAllocationsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  organizations: OrganizationRepository;
  projects: ProjectRepository;
  allocations: AllocationRepository;
  audit: AuditRecorder;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  async function roleInOrg(orgId: string, userId: string) {
    return deps.organizations.roleForUser(orgId, userId);
  }

  /**
   * Resolves a project that is genuinely inside the organization in the path,
   * so an admin of org A cannot read or write a cap on org B's project by
   * guessing its id.
   */
  async function projectInOrg(projectId: string, organizationId: string) {
    if (!isUuid(projectId)) return null;
    const project = await deps.projects.findById(projectId);
    if (!project || project.organizationId !== organizationId) return null;
    return project;
  }

  router.get("/:organizationId/allocations", requireAuth, async (req, res) => {
    const orgId = routeParam(req.params.organizationId);
    if (!isUuid(orgId)) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (!role) {
      res.status(403).json({ error: "Not a member of this organization" });
      return;
    }

    const stored = await deps.allocations.listForOrganization(orgId);
    const { start, end } = monthPeriod(new Date());

    const projects = await Promise.all(
      stored.map(async (entry) => {
        const usedTokens = await deps.allocations.tokensUsedInPeriod(
          entry.projectId,
          start,
          end,
        );
        return {
          ...toEffectiveAllocation(entry.projectId, entry.cap, entry.quota),
          projectName: entry.projectName,
          capState: evaluateTokenCap({
            projectId: entry.projectId,
            cap: entry.cap?.monthlyTokenCap ?? null,
            usedTokens,
            now: new Date(),
          }),
        };
      }),
    );

    const body: OrganizationAllocationsResponse = {
      organizationId: orgId,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      defaults: DEFAULT_RESOURCE_QUOTA,
      projects,
    };
    res.json(body);
  });

  const capSchema = z.object({
    // Null clears the cap; 0 is a real value meaning "permit nothing further".
    monthlyTokenCap: z.number().int().min(0).nullable(),
  });

  router.put(
    "/:organizationId/allocations/projects/:projectId/token-cap",
    requireAuth,
    async (req, res) => {
      const orgId = routeParam(req.params.organizationId);
      const projectId = routeParam(req.params.projectId);
      if (!isUuid(orgId)) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }
      const role = await roleInOrg(orgId, req.currentUser!.id);
      if (role !== "admin") {
        res.status(403).json({ error: "Admin role required" });
        return;
      }
      const project = await projectInOrg(projectId, orgId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const parsed = capSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
        return;
      }

      const previous = await deps.allocations.findTokenCap(projectId);
      if (parsed.data.monthlyTokenCap === null) {
        await deps.allocations.clearTokenCap(projectId);
      } else {
        await deps.allocations.setTokenCap(projectId, parsed.data.monthlyTokenCap);
      }

      await deps.audit.record(res, {
        organizationId: orgId,
        projectId,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.projectTokenCapSet,
        targetId: projectId,
        metadata: {
          previousCap: previous?.monthlyTokenCap ?? null,
          monthlyTokenCap: parsed.data.monthlyTokenCap,
        },
      });

      const { start, end } = monthPeriod(new Date());
      const usedTokens = await deps.allocations.tokensUsedInPeriod(projectId, start, end);
      res.json(
        evaluateTokenCap({
          projectId,
          cap: parsed.data.monthlyTokenCap,
          usedTokens,
          now: new Date(),
        }),
      );
    },
  );

  const quotaSchema = z.object({
    // Bounds are sanity rails, not policy: a namespace with a 1-pod quota could
    // not hold the primary deployment, and 1 TiB/1k cores is far past any
    // single self-hosted cluster this product targets.
    cpuMillicores: z.number().int().min(100).max(1_000_000),
    memoryMib: z.number().int().min(128).max(1_048_576),
    pods: z.number().int().min(1).max(1000),
  });

  router.put(
    "/:organizationId/allocations/projects/:projectId/quota",
    requireAuth,
    async (req, res) => {
      const orgId = routeParam(req.params.organizationId);
      const projectId = routeParam(req.params.projectId);
      if (!isUuid(orgId)) {
        res.status(404).json({ error: "Organization not found" });
        return;
      }
      const role = await roleInOrg(orgId, req.currentUser!.id);
      if (role !== "admin") {
        res.status(403).json({ error: "Admin role required" });
        return;
      }
      const project = await projectInOrg(projectId, orgId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const parsed = quotaSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
        return;
      }

      const previous = await deps.allocations.findResourceQuota(projectId);
      const saved = await deps.allocations.setResourceQuota(projectId, parsed.data);

      await deps.audit.record(res, {
        organizationId: orgId,
        projectId,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.projectResourceQuotaSet,
        targetId: projectId,
        metadata: {
          previous: previous
            ? {
                cpuMillicores: previous.cpuMillicores,
                memoryMib: previous.memoryMib,
                pods: previous.pods,
              }
            : null,
          cpuMillicores: saved.cpuMillicores,
          memoryMib: saved.memoryMib,
          pods: saved.pods,
        },
      });

      res.json({
        projectId,
        ...toEffectiveAllocation(projectId, null, saved).quota,
      });
    },
  );

  return router;
}
