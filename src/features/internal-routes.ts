import { Router } from "express";
import { config } from "../config.js";
import { mintInstallationAccessToken } from "../github/github-api.js";
import type { GithubInstallationRepository } from "../github/installation-repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { TestRepository } from "../tests/repository.js";
import type { FeatureRepository } from "./repository.js";

/**
 * Serves a job's feature payload back to the Orchestrator at claim time
 * (ADR 006 item 5, widened by ADR 010 item 1): the feature title, its
 * featureType ("normal" | "project_init" — ADR 008 item 1, lets
 * buildInitialPrompt pick the right skill instead of the model inferring it
 * from the title), and the project's linked repos, plus a fresh job-scoped
 * GitHub installation token. The token is minted here rather than read from
 * `project_secrets` — it's short-lived and per-job (ADR 005 §14), the same
 * as the chart-fetch/chart-scaffold token, not a static project secret like
 * the model config (ADR 004).
 *
 * The `kind` query param (passed by the Orchestrator, which already knows
 * its own job.Kind) branches both the response shape and the minted
 * token's scope — this is the existing internal, bearer-token-only surface
 * (`requireInternalApiToken`), not user-facing, so a caller-supplied kind
 * carries no privilege-escalation risk beyond what an internal service is
 * already trusted with. `test_run` additionally requires a testId and
 * returns that test's markdown and the feature ref.
 */
export function createFeaturesInternalRouter(deps: {
  features: FeatureRepository;
  projects: ProjectRepository;
  installations: GithubInstallationRepository;
  tests: TestRepository;
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
      const isFeatureBuild = req.query.kind === "feature_build";
      const isTestRun = req.query.kind === "test_run";
      const isScriptTestRun = req.query.kind === "script_test_run";
      const isAgenticReview = req.query.kind === "agentic_review";

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

      const testId = typeof req.query.testId === "string" ? req.query.testId : null;
      const scriptName =
        req.query.scriptName === "unit" || req.query.scriptName === "integration"
          ? req.query.scriptName
          : null;
      if (isScriptTestRun && !scriptName) {
        res.status(400).json({ error: "scriptName is required for script_test_run" });
        return;
      }
      const test =
        isTestRun && testId ? await deps.tests.findById(projectId, testId) : null;
      if (isTestRun && !test) {
        res.status(404).json({ error: "Test not found" });
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
        // feature_build is the opposite case: it's expected to commit and
        // open a draft PR (job-dispatch.md), so it needs a write-capable
        // token instead (ADR 010 item 1). `workflows: write` is required in
        // addition to `contents: write`: GitHub enforces Workflows as a
        // separate permission for any create/update under
        // `.github/workflows/`, even with Contents write access — omitting
        // it makes GitHub reject the push server-side (ADR 005 §3 amendment).
        const { token } = await mintInstallationAccessToken(
          installation.githubInstallationId,
          config.github.appId,
          config.github.appPrivateKey,
          isFeatureBuild
            ? { contents: "write", pull_requests: "write", workflows: "write" }
            : { contents: "read" },
        );

        res.json({
          title: feature.title,
          featureType: feature.featureType,
          repos: project.repositories.map((repo) => ({
            cloneUrl: `https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`,
            isPrimary: repo.isPrimary,
          })),
          githubToken: token,
          // adrMarkdown/branch satisfy feature_build/skills/implement/
          // SKILL.md's own documented assumptions (ADR 010 item 3): the
          // approved ADR to implement, and the feature branch name
          // (job-dispatch.md's yggdrasil/<feature-slug>-<id> convention)
          // entrypoint.sh checks out before Pi starts. Both omitted for
          // spec_grill, which has no ADR yet and clones each repo's default
          // branch.
          ...(isFeatureBuild || isTestRun || isScriptTestRun || isAgenticReview
            ? {
                adrMarkdown: feature.adrMarkdown ?? "",
                branch: `yggdrasil/${feature.slug}-${feature.id}`,
                ...(isTestRun || isScriptTestRun || isAgenticReview
                  ? { ref: `yggdrasil/${feature.slug}-${feature.id}` }
                  : {}),
              }
            : {}),
          ...(isTestRun
            ? {
                testId: test!.id,
                testMarkdown: test!.specMarkdown,
                ref: `yggdrasil/${feature.slug}-${feature.id}`,
              }
            : {}),
          ...(isScriptTestRun ? { scriptName } : {}),
        });
      } catch (error) {
        console.error(`feature spec fetch failed for feature ${featureId}:`, error);
        res.status(502).json({ error: "Failed to mint GitHub credentials" });
      }
    },
  );

  router.get(
    "/projects/:projectId/tests/:testId/spec",
    requireInternalApiToken,
    async (req, res) => {
      const projectId = routeParam(req.params.projectId);
      const testId = routeParam(req.params.testId);
      if (!isUuid(projectId) || !isUuid(testId)) {
        res.status(404).json({ error: "Test not found" });
        return;
      }
      const project = await deps.projects.findById(projectId);
      const test = await deps.tests.findById(projectId, testId);
      if (!project || !project.installationId || !test) {
        res.status(404).json({ error: "Test not found" });
        return;
      }
      const installation = await deps.installations.findById(project.installationId);
      if (!installation) {
        res.status(404).json({ error: "Test not found" });
        return;
      }
      try {
        const { token } = await mintInstallationAccessToken(
          installation.githubInstallationId,
          config.github.appId,
          config.github.appPrivateKey,
          { contents: "read" },
        );
        res.json({
          title: test.name,
          featureType: "normal",
          repos: project.repositories.map((repo) => ({
            cloneUrl: `https://github.com/${repo.githubOwner}/${repo.githubRepo}.git`,
            isPrimary: repo.isPrimary,
          })),
          githubToken: token,
          testId: test.id,
          testMarkdown: test.specMarkdown,
          ref: typeof req.query.ref === "string" ? req.query.ref : "main",
        });
      } catch (error) {
        console.error(`test spec fetch failed for test ${testId}:`, error);
        res.status(502).json({ error: "Failed to mint GitHub credentials" });
      }
    },
  );

  return router;
}
