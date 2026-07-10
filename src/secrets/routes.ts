import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import { MODEL_CONFIG_KEYS, resolveModelConfig } from "./model-config.js";
import type { SecretRepository } from "./repository.js";
import type { UserSecretRepository } from "./user-repository.js";

const upsertSecretSchema = z.object({
  key: z.string().trim().min(1).max(128),
  value: z.string(),
});

export function createSecretsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  secrets: SecretRepository;
  userSecrets: UserSecretRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  async function getOwnedProject(req: Parameters<typeof requireAuth>[0], projectId: string) {
    if (!isUuid(projectId)) {
      return null;
    }
    const user = req.currentUser;
    if (!user) return null;
    return deps.projects.findByIdForUser(projectId, user.id);
  }

  router.get("/:projectId/secrets", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const secrets = await deps.secrets.listForProject(project.id);
    res.json(secrets);
  });

  router.put("/:projectId/secrets", requireAuth, async (req, res) => {
    const parsed = upsertSecretSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const secret = await deps.secrets.upsert(project.id, parsed.data.key, parsed.data.value);

    if (project.modelConfigWarning && (MODEL_CONFIG_KEYS as readonly string[]).includes(parsed.data.key)) {
      const resolved = await resolveModelConfig(deps, project.id, project.ownerUserId);
      if (resolved) {
        await deps.projects.clearModelConfigWarning(project.id);
      }
    }

    res.status(200).json(secret);
  });

  router.delete("/:projectId/secrets/:secretId", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const secretId = routeParam(req.params.secretId);
    if (!isUuid(secretId)) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const deleted = await deps.secrets.delete(project.id, secretId);
    if (!deleted) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    res.status(204).send();
  });

  return router;
}
