import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import type { JobPreviewRepository } from "./repository.js";
import { toPublicJobPreview } from "./types.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { UserRepository } from "../users/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";

/**
 * A project's ephemeral preview deployments (ADR 003 §15), read-only.
 *
 * The registry is written by the Orchestrator through `/internal/*`; there is
 * nothing for a user to mutate here. Previews appear and disappear with their
 * jobs, and a manual teardown control is deliberately not offered — it would
 * need its own authorization story and audit action for something the TTL
 * sweep already handles.
 *
 * Mounted on `/projects` alongside the designs/deploys routers. No param
 * segment in common with them (`/:projectId/previews` is a single literal
 * third segment), so nothing here can shadow a sibling route.
 */
export function createPreviewsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  previews: JobPreviewRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  /**
   * Project membership is the read gate, matching how a project's designs,
   * deploys and features are read. Every query is scoped by the resolved
   * project id, so one project's previews — and the hosts they expose — cannot
   * be enumerated through another project by guessing ids.
   */
  async function getOwnedProject(req: Parameters<typeof requireAuth>[0], projectId: string) {
    if (!isUuid(projectId)) return null;
    const user = req.currentUser;
    if (!user) return null;
    return deps.projects.findByIdForUser(projectId, user.id);
  }

  router.get("/:projectId/previews", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const previews = await deps.previews.listForProject(project.id);
    res.json({ previews: previews.map(toPublicJobPreview) });
  });

  return router;
}
