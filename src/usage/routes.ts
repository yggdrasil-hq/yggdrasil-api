import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import type { OrganizationRepository } from "../organizations/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import { UserRepository } from "../users/repository.js";
import type { JobUsageRepository, UsageScope } from "./repository.js";

/**
 * ADR 023's read side: token/cost consumption aggregates, org- and
 * project-scoped. Read-only — the reporting half of #6, with caps and
 * enforcement deliberately out of scope (issue #18).
 *
 * Authorization mirrors the neighbouring read routes rather than inventing a
 * capability: organization analytics is visible to any member (the same
 * membership check `GET /organizations/:id/members` uses), and project
 * analytics to anyone with project access (`findByIdForUser`'s
 * organization-membership join, the shape every other project read uses).
 * Nothing here is secret material — it is the org's own metered consumption —
 * and every query is scoped by the org/project the caller was just checked
 * against, so one org's usage can never appear in another's response.
 */

/** Windows are short by design: this is operational reporting, not archiving. */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

/** Rows in the analytics "recent sessions" list. */
const RECENT_SESSION_LIMIT = 25;

const rangeQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(MAX_DAYS).optional(),
});

/**
 * Builds the window a request asked for. `to` is exclusive and pinned to the
 * next UTC day boundary *after* now, so "the last 30 days" always includes
 * everything that happened today rather than cutting off mid-day depending on
 * what time the request arrived.
 */
export function resolveUsageScope(input: {
  organizationId: string;
  projectId?: string;
  days: number;
}): UsageScope {
  const now = Date.now();
  const to = new Date(Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000);
  const from = new Date(to.getTime() - input.days * 86_400_000);
  const previousFrom = new Date(from.getTime() - input.days * 86_400_000);
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    from,
    to,
    previousFrom,
    recentLimit: RECENT_SESSION_LIMIT,
  };
}

export function createUsageRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  organizations: OrganizationRepository;
  projects: ProjectRepository;
  usage: JobUsageRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  function parseDays(req: { query: unknown }): number | null {
    const parsed = rangeQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return null;
    }
    return parsed.data.days ?? DEFAULT_DAYS;
  }

  // --- Organization scope ---

  router.get("/organizations/:organizationId/usage", requireAuth, async (req, res) => {
    const orgId = routeParam(req.params.organizationId);
    if (!isUuid(orgId)) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await deps.organizations.roleForUser(orgId, req.currentUser!.id);
    if (!role) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const days = parseDays(req);
    if (days === null) {
      res.status(400).json({ error: "Invalid range" });
      return;
    }

    const report = await deps.usage.organizationUsage(
      resolveUsageScope({ organizationId: orgId, days }),
    );
    res.json(report);
  });

  router.get("/organizations/:organizationId/analytics", requireAuth, async (req, res) => {
    const orgId = routeParam(req.params.organizationId);
    if (!isUuid(orgId)) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await deps.organizations.roleForUser(orgId, req.currentUser!.id);
    if (!role) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const days = parseDays(req);
    if (days === null) {
      res.status(400).json({ error: "Invalid range" });
      return;
    }

    const report = await deps.usage.organizationAnalytics(
      resolveUsageScope({ organizationId: orgId, days }),
    );
    res.json(report);
  });

  // --- Project scope ---

  router.get("/projects/:projectId/usage", requireAuth, async (req, res) => {
    const projectId = routeParam(req.params.projectId);
    if (!isUuid(projectId)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const project = await deps.projects.findByIdForUser(projectId, req.currentUser!.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const days = parseDays(req);
    if (days === null) {
      res.status(400).json({ error: "Invalid range" });
      return;
    }

    const report = await deps.usage.projectUsage(
      resolveUsageScope({ organizationId: project.organizationId, projectId, days }),
    );
    res.json(report);
  });

  router.get("/projects/:projectId/analytics", requireAuth, async (req, res) => {
    const projectId = routeParam(req.params.projectId);
    if (!isUuid(projectId)) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const project = await deps.projects.findByIdForUser(projectId, req.currentUser!.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const days = parseDays(req);
    if (days === null) {
      res.status(400).json({ error: "Invalid range" });
      return;
    }

    const report = await deps.usage.projectAnalytics(
      resolveUsageScope({ organizationId: project.organizationId, projectId, days }),
    );
    res.json(report);
  });

  return router;
}
