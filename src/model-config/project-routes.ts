import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { OrgModelRepository } from "./model-repository.js";
import type { ProjectModelOverrideRepository } from "./project-override-repository.js";
import { AGENT_JOB_KINDS } from "./types.js";
import type { AgentJobKind } from "./types.js";
import { AUDIT_ACTIONS } from "../audit/actions.js";
import type { AuditRecorder } from "../audit/record.js";

const jobKindSchema = z.enum(AGENT_JOB_KINDS);

const setOverrideSchema = z.object({
  modelId: z.string().uuid(),
});

/**
 * ADR 018 item 5: a project's catalog-based override of its org's per-job-kind
 * default model. Same project-access gate as project_secrets routes — no
 * extra RBAC beyond project membership.
 */
export function createProjectModelOverridesRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  models: OrgModelRepository;
  projectOverrides: ProjectModelOverrideRepository;
  audit: AuditRecorder;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  async function getOwnedProject(req: Parameters<typeof requireAuth>[0], projectId: string) {
    if (!isUuid(projectId)) return null;
    const user = req.currentUser;
    if (!user) return null;
    return deps.projects.findByIdForUser(projectId, user.id);
  }

  router.get("/:projectId/job-model-overrides", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const overrides = await deps.projectOverrides.listForProject(project.id);
    res.json(overrides);
  });

  router.put("/:projectId/job-model-overrides/:jobKind", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const jobKindParsed = jobKindSchema.safeParse(req.params.jobKind);
    if (!jobKindParsed.success) {
      res.status(400).json({ error: "Invalid job kind" });
      return;
    }
    const parsed = setOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const model = await deps.models.findById(project.organizationId, parsed.data.modelId);
    if (!model) {
      res.status(400).json({ error: "Model not found" });
      return;
    }
    const override = await deps.projectOverrides.upsert(
      project.id,
      jobKindParsed.data as AgentJobKind,
      parsed.data.modelId,
    );
    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.projectModelOverrideSet,
      targetType: "project_model_override",
      targetId: model.id,
      metadata: { jobKind: jobKindParsed.data, displayName: model.displayName },
    });
    res.status(200).json(override);
  });

  router.delete("/:projectId/job-model-overrides/:jobKind", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const jobKindParsed = jobKindSchema.safeParse(req.params.jobKind);
    if (!jobKindParsed.success) {
      res.status(400).json({ error: "Invalid job kind" });
      return;
    }
    const cleared = await deps.projectOverrides.clear(project.id, jobKindParsed.data as AgentJobKind);
    if (cleared) {
      await deps.audit.record(res, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.projectModelOverrideCleared,
        targetType: "project_model_override",
        metadata: { jobKind: jobKindParsed.data },
      });
    }
    res.status(cleared ? 204 : 404).send();
  });

  return router;
}
