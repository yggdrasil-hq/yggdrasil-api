import { Router } from "express";
import { config } from "../config.js";
import { mintInstallationAccessToken } from "../github/github-api.js";
import type { GithubInstallationRepository } from "../github/installation-repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { FeatureRepository } from "./repository.js";

/**
 * Serves a spec_grill job's payload back to the Orchestrator at claim time
 * (ADR 006 item 5): the feature title, its featureType ("normal" |
 * "project_init" — ADR 008 item 1, lets buildInitialPrompt pick the right
 * skill instead of the model inferring it from the title), and the
 * project's linked repos, plus a fresh job-scoped GitHub installation
 * token. The token is minted here rather than read from `project_secrets`
 * — it's short-lived and per-job (ADR 005 §14), the same as the
 * chart-fetch/chart-scaffold token, not a static project secret like the
 * model config (ADR 004).
 */
export function createFeaturesInternalRouter(deps: {
  features: FeatureRepository;
  projects: ProjectRepository;
  installations: GithubInstallationRepository;
}): Router {
  const router = Router();

  router.get(
    "/projects/:projectId/features/:featureId/spec",
    requireInternalApiToken,
    async (req, res) => {
      const projectId = routeParam(req.params.projectId);
      const featureId = routeParam(req.params.featureId);
      if (!isUuid(projectId) || !isUuid(featureId)) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const feature = await deps.features.findById(projectId, featureId);
      if (!feature) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const project = await deps.projects.findById(projectId);
      if (!project || !project.installationId) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const installation = await deps.installations.findById(project.installationId);
      if (!installation) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      try {
        // spec_grill only ever reads (explores the repo, conducts the grill
        // interview, submits an ADR) — scoping the token to contents:read
        // means a stray `git push`/`gh pr create` from inside the container
        // (its bash tool is unrestricted; only the yggdrasil-contract tools
        // are allowlisted) fails at GitHub regardless, instead of relying
        // solely on the skill's own instructions and tool allowlist.
        const { token } = await mintInstallationAccessToken(
          installation.githubInstallationId,
          config.github.appId,
          config.github.appPrivateKey,
          { contents: "read" },
        );

        res.json({
          title: feature.title,
          featureType: feature.featureType,
          repos: project.repositories.map((repo) => ({
            cloneUrl: `https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`,
            isPrimary: repo.isPrimary,
          })),
          githubToken: token,
        });
      } catch (error) {
        console.error(`feature spec fetch failed for feature ${featureId}:`, error);
        res.status(502).json({ error: "Failed to mint GitHub credentials" });
      }
    },
  );

  return router;
}
