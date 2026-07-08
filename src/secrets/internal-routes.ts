import { Router } from "express";
import { isUuid } from "../shared/uuid.js";
import { routeParam } from "../shared/route-param.js";
import { requireInternalApiToken } from "./internal-auth.js";
import type { SecretRepository } from "./repository.js";

/**
 * The only place decrypted project secrets ever leave the API process —
 * called by the Orchestrator at deploy time (ADR 003 §16), never by
 * session-authenticated (user-facing) routes.
 */
export function createSecretsInternalRouter(deps: { secrets: SecretRepository }): Router {
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

      const secrets = await deps.secrets.decryptAllForProject(projectId);
      res.json({ secrets });
    },
  );

  return router;
}
