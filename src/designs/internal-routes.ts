import { Router } from "express";
import { config } from "../config.js";
import { mintInstallationAccessToken } from "../github/github-api.js";
import type { GithubInstallationRepository } from "../github/installation-repository.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { DesignRepository } from "./repository.js";
import type { DesignContinuationContext } from "./repository.js";
import { composeDesignBrief } from "./brief.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";

/** Supplies a design_grill pod with its project, design, and GitHub payload. */
export function createDesignsInternalRouter(deps: {
  jobs: JobRepository;
  projects: ProjectRepository;
  installations: GithubInstallationRepository;
  designs: DesignRepository;
}): Router {
  const router = Router();

  router.get(
    "/projects/:projectId/designs/:sessionId/spec",
    requireInternalApiToken,
    async (req, res) => {
      const projectId = routeParam(req.params.projectId);
      const sessionId = routeParam(req.params.sessionId);
      if (!isUuid(projectId) || !isUuid(sessionId)) {
        res.status(404).json({ error: "Design session not found" });
        return;
      }

      const [project, job] = await Promise.all([
        deps.projects.findById(projectId),
        deps.jobs.findByIdForProject(projectId, sessionId),
      ]);
      if (!project || !job || job.kind !== "design_grill" || !project.installationId) {
        res.status(404).json({ error: "Design session not found" });
        return;
      }

      const installation = await deps.installations.findById(project.installationId);
      if (!installation) {
        res.status(404).json({ error: "Design session not found" });
        return;
      }

      try {
        const { token } = await mintInstallationAccessToken(
          installation.githubInstallationId,
          config.github.appId,
          config.github.appPrivateKey,
          { contents: "write", pull_requests: "write" },
        );
        const slug = job.designSlug ?? "design";
        // ADR 020 item 5: a re-opened design tells the agent what already
        // exists, so it iterates on the committed folder instead of starting a
        // parallel one. Best-effort — a failure here degrades the session to a
        // cold start rather than failing it, since the skill's own step 1 also
        // inspects `designs/<slug>/` if it happens to be present.
        let continuation: DesignContinuationContext | null = null;
        try {
          continuation = await deps.designs.findContinuationContext(
            project.id,
            slug,
            job.id,
          );
        } catch (error) {
          console.error(`design continuation lookup failed for session ${sessionId}:`, error);
        }
        res.json({
          name: job.designName ?? slug,
          slug,
          description: composeDesignBrief(
            job.designDescription ?? "",
            slug,
            continuation,
          ),
          branch: `yggdrasil/design-${slug}-${job.id}`,
          repos: project.repositories.map((repo) => ({
            cloneUrl: `https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`,
            isPrimary: repo.isPrimary,
          })),
          githubToken: token,
        });
      } catch (error) {
        console.error(`design spec fetch failed for session ${sessionId}:`, error);
        res.status(502).json({ error: "Failed to mint GitHub credentials" });
      }
    },
  );

  return router;
}
