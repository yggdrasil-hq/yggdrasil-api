import { Router } from "express";
import { config } from "../config.js";
import { fetchRepositoryDirectory, mintInstallationAccessToken } from "../github/github-api.js";
import type { GithubInstallationRepository } from "../github/installation-repository.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { ProjectRepository } from "./repository.js";

const CHART_DIR = ".yggdrasil/chart";

/**
 * Serves a project's scaffolded Helm chart back to the Orchestrator at
 * deploy time (ADR 003 §12) — the only place a project's repo content is
 * read for this purpose. Mirrors the internal-secrets-endpoint pattern from
 * Phase 3b: the Orchestrator never gets GitHub credentials of its own.
 */
export function createProjectsInternalRouter(deps: {
  projects: ProjectRepository;
  installations: GithubInstallationRepository;
}): Router {
  const router = Router();

  router.get(
    "/projects/:projectId/slug",
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

      res.json({ slug: project.slug });
    },
  );

  router.get(
    "/projects/:projectId/chart",
    requireInternalApiToken,
    async (req, res) => {
      const projectId = routeParam(req.params.projectId);
      if (!isUuid(projectId)) {
        res.status(404).json({ error: "Chart not found" });
        return;
      }

      const project = await deps.projects.findById(projectId);
      if (!project || !project.installationId) {
        res.status(404).json({ error: "Chart not found" });
        return;
      }

      const primary = project.repositories.find((repo) => repo.isPrimary);
      if (!primary) {
        res.status(404).json({ error: "Chart not found" });
        return;
      }

      const installation = await deps.installations.findById(project.installationId);
      if (!installation) {
        res.status(404).json({ error: "Chart not found" });
        return;
      }

      try {
        const { token } = await mintInstallationAccessToken(
          installation.githubInstallationId,
          config.github.appId,
          config.github.appPrivateKey,
        );
        const files = await fetchRepositoryDirectory(
          primary.githubOwner,
          primary.githubRepo,
          "main",
          CHART_DIR,
          token,
        );
        if (!files) {
          res.status(404).json({ error: "Chart not found" });
          return;
        }
        res.json({ files });
      } catch (error) {
        console.error(`chart fetch failed for project ${projectId}:`, error);
        res.status(502).json({ error: "Failed to fetch chart" });
      }
    },
  );

  return router;
}
