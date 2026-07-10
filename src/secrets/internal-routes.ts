import { Router } from "express";
import { isUuid } from "../shared/uuid.js";
import { routeParam } from "../shared/route-param.js";
import { requireInternalApiToken } from "./internal-auth.js";
import { MODEL_CONFIG_KEYS, resolveModelConfig } from "./model-config.js";
import type { SecretRepository } from "./repository.js";
import type { UserSecretRepository } from "./user-repository.js";
import type { ProjectRepository } from "../projects/repository.js";

/**
 * The only place decrypted project secrets ever leave the API process —
 * called by the Orchestrator at deploy time (ADR 003 §16), never by
 * session-authenticated (user-facing) routes.
 */
export function createSecretsInternalRouter(deps: {
  secrets: SecretRepository;
  userSecrets: UserSecretRepository;
  projects: ProjectRepository;
}): Router {
  const router = Router();

  router.get(
    "/projects/:projectId/secrets",
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

      const secrets = await deps.secrets.decryptAllForProject(projectId);

      // Model config resolves live (project bundle, else the owning user's
      // default — ADR 007), merged over any other arbitrary project secret.
      const modelConfig = await resolveModelConfig(deps, projectId, project.ownerUserId);
      if (modelConfig) {
        for (const key of MODEL_CONFIG_KEYS) {
          secrets[key] = modelConfig[key];
        }
      } else {
        for (const key of MODEL_CONFIG_KEYS) {
          delete secrets[key];
        }
      }

      res.json({ secrets });
    },
  );

  return router;
}
