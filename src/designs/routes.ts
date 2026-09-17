import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import type { DesignRepository } from "./repository.js";
import { toPublicDesign, toPublicDesignSession } from "./types.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { UserRepository } from "../users/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";

/**
 * Design browse/history (ADR 020 item 6, issue #2). Read-only: the index is
 * written by the routes that start and finalize sessions, and the artifact
 * itself lives in the managed repo — so there is nothing to mutate here.
 *
 * Mounted on the same `/projects` prefix as the feature/project routers, with
 * no param segment in common (their design routes all carry a third segment,
 * e.g. `/:projectId/designs/:sessionId/events`), so nothing here can shadow
 * them.
 */
export function createDesignsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  designs: DesignRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  /**
   * Project membership is the read gate, matching how a project's features and
   * tests are read — no extra RBAC beyond membership. Every query below is
   * scoped by the resolved project id, so a design cannot be read through
   * another project (or another organization) by guessing its id.
   */
  async function getOwnedProject(
    req: Parameters<typeof requireAuth>[0],
    projectId: string,
  ) {
    if (!isUuid(projectId)) return null;
    const user = req.currentUser;
    if (!user) return null;
    return deps.projects.findByIdForUser(projectId, user.id);
  }

  router.get("/:projectId/designs", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const designs = await deps.designs.listForProject(project.id);
    res.json({ designs: designs.map(toPublicDesign) });
  });

  router.get("/:projectId/designs/:designId", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const designId = routeParam(req.params.designId);
    if (!isUuid(designId)) {
      res.status(404).json({ error: "Design not found" });
      return;
    }

    const found = await deps.designs.findByIdForProject(project.id, designId);
    if (!found) {
      res.status(404).json({ error: "Design not found" });
      return;
    }

    const sessions = await deps.designs.listSessions(found.design.id);
    res.json({
      design: toPublicDesign(found),
      sessions: sessions.map(toPublicDesignSession),
    });
  });

  return router;
}
