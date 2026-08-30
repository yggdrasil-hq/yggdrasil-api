import { Router } from "express";
import { isUuid } from "../shared/uuid.js";
import { routeParam } from "../shared/route-param.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { OrganizationClusterRepository } from "./cluster-repository.js";

/**
 * ADR 016 item 13: the Orchestrator resolves a job's target cluster via its
 * project -> organization. These internal, bearer-token endpoints are the
 * only place the decrypted org kubeconfig leaves the API process — never a
 * session-authenticated route. A project's organization comes from its
 * organization_id column (ADR 016 item 4, Track A3).
 */
export function createOrganizationsInternalRouter(deps: {
  projects: ProjectRepository;
  clusters: OrganizationClusterRepository;
}): Router {
  const router = Router();

  // Resolve a project's owning organization and return its configured
  // (decrypted) kubeconfig, or a 409 if the org has no cluster configured
  // yet (the hard gate: no platform-default cluster exists).
  router.get(
    "/projects/:projectId/organization-cluster",
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

      const organizationId = project.organizationId;
      const kubeconfig = await deps.clusters.decryptKubeconfig(organizationId);
      if (!kubeconfig) {
        // Hard gate (ADR 016 items 11): every org must configure its own
        // cluster, no platform default.
        res.status(409).json({ error: "Organization has no cluster configured" });
        return;
      }

      res.json({ organizationId, kubeconfig });
    },
  );

  return router;
}