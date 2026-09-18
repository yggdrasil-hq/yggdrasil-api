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
 *
 * **Two routers, one per scope, registered with relative paths (issue #56).**
 * This module used to export a single router whose routes carried their own
 * full paths — `/organizations/:organizationId/usage` and friends — which
 * `app.ts` then mounted at `/organizations` *and* `/projects`. Express joins the
 * mount prefix onto the route path, so the effective paths were
 * `/organizations/organizations/:id/usage` and `/projects/projects/:id/usage` and
 * all four documented endpoints 404'd in every real deployment:
 *
 *     /api/organizations/:id/usage             404
 *     /api/organizations/organizations/:id/usage  200  <- the only thing served
 *
 * The route tests mounted the router at root, which is the one prefix that makes
 * absolute paths work, so they passed while the app was broken — the wiring was
 * never exercised.
 *
 * The paths are now **relative**, matching all twelve sibling routers, and each
 * factory is mounted at the prefix it belongs to. That makes the mount
 * meaningful rather than decorative, gives each scope its natural parameter name
 * (`:organizationId` under `/organizations`, `:projectId` under `/projects`),
 * and means a route added here by following the neighbouring files cannot
 * reintroduce the mismatch. `app.ts`'s own wiring is now asserted by
 * `src/app.routing.test.ts`, which is the guard whose absence allowed this.
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

/** The dependencies both scope routers need. */
export interface UsageRouterDeps {
  users: UserRepository;
  sessions: SessionService;
  organizations: OrganizationRepository;
  projects: ProjectRepository;
  usage: JobUsageRepository;
}

/**
 * The `?days=` window, or null when the query is malformed.
 *
 * Module-level rather than a closure inside each factory: it reads nothing from
 * the dependencies, and keeping one copy means the two scopes cannot disagree
 * about what a valid range is.
 */
function parseDays(req: { query: unknown }): number | null {
  const parsed = rangeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.days ?? DEFAULT_DAYS;
}

/**
 * Organization-scoped usage and analytics. Mount at `/organizations`.
 *
 * The `:organizationId` parameter is validated for shape *and* membership, in
 * that order: an unknown org and a malformed one both answer 404 rather than
 * distinguishing "does not exist" from "not yours", which is the same
 * non-disclosure the neighbouring org reads use.
 */
export function createOrganizationUsageRouter(deps: UsageRouterDeps): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  async function resolveOrganization(
    req: Parameters<typeof requireAuth>[0],
    res: Parameters<typeof requireAuth>[1],
  ): Promise<{ organizationId: string; days: number } | null> {
    const organizationId = routeParam(req.params.organizationId);
    if (!isUuid(organizationId)) {
      res.status(404).json({ error: "Organization not found" });
      return null;
    }
    const role = await deps.organizations.roleForUser(organizationId, req.currentUser!.id);
    if (!role) {
      res.status(404).json({ error: "Organization not found" });
      return null;
    }
    const days = parseDays(req);
    if (days === null) {
      res.status(400).json({ error: "Invalid range" });
      return null;
    }
    return { organizationId, days };
  }

  router.get("/:organizationId/usage", requireAuth, async (req, res) => {
    const resolved = await resolveOrganization(req, res);
    if (!resolved) return;

    const report = await deps.usage.organizationUsage(
      resolveUsageScope({ organizationId: resolved.organizationId, days: resolved.days }),
    );
    res.json(report);
  });

  router.get("/:organizationId/analytics", requireAuth, async (req, res) => {
    const resolved = await resolveOrganization(req, res);
    if (!resolved) return;

    const report = await deps.usage.organizationAnalytics(
      resolveUsageScope({ organizationId: resolved.organizationId, days: resolved.days }),
    );
    res.json(report);
  });

  return router;
}

/**
 * Project-scoped usage and analytics. Mount at `/projects`.
 *
 * Project access is `findByIdForUser`, which is an organization-membership join
 * — the same gate every other project read uses. The scope handed to the
 * repository carries the project's *real* `organizationId` (read from the row,
 * not from the caller), so a caller cannot point a project read at another
 * organization's aggregation.
 */
export function createProjectUsageRouter(deps: UsageRouterDeps): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  async function resolveProject(
    req: Parameters<typeof requireAuth>[0],
    res: Parameters<typeof requireAuth>[1],
  ): Promise<{ organizationId: string; projectId: string; days: number } | null> {
    const projectId = routeParam(req.params.projectId);
    if (!isUuid(projectId)) {
      res.status(404).json({ error: "Project not found" });
      return null;
    }
    const project = await deps.projects.findByIdForUser(projectId, req.currentUser!.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return null;
    }
    const days = parseDays(req);
    if (days === null) {
      res.status(400).json({ error: "Invalid range" });
      return null;
    }
    return { organizationId: project.organizationId, projectId, days };
  }

  router.get("/:projectId/usage", requireAuth, async (req, res) => {
    const resolved = await resolveProject(req, res);
    if (!resolved) return;

    const report = await deps.usage.projectUsage(
      resolveUsageScope({
        organizationId: resolved.organizationId,
        projectId: resolved.projectId,
        days: resolved.days,
      }),
    );
    res.json(report);
  });

  router.get("/:projectId/analytics", requireAuth, async (req, res) => {
    const resolved = await resolveProject(req, res);
    if (!resolved) return;

    const report = await deps.usage.projectAnalytics(
      resolveUsageScope({
        organizationId: resolved.organizationId,
        projectId: resolved.projectId,
        days: resolved.days,
      }),
    );
    res.json(report);
  });

  return router;
}
