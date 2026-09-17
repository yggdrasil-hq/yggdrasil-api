import { Router } from "express";
import { isUuid } from "../shared/uuid.js";
import { routeParam } from "../shared/route-param.js";
import { requireInternalApiToken } from "./internal-auth.js";
import { MODEL_CONFIG_KEYS, resolveModelConfigForJob } from "./model-config.js";
import type { ModelConfigResolutionDeps } from "./model-config.js";
import type { SecretRepository } from "./repository.js";
import type { FeatureModelSecretRepository } from "./feature-model-repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { FeatureRepository } from "../features/repository.js";
import type { OrgProviderRepository } from "../model-config/provider-repository.js";
import type { OrgModelRepository } from "../model-config/model-repository.js";
import type { JobModelDefaultRepository } from "../model-config/job-default-repository.js";
import type { ProjectModelOverrideRepository } from "../model-config/project-override-repository.js";
import type { FeatureJobModelOverrideRepository } from "../model-config/feature-override-repository.js";
import { AGENT_JOB_KINDS, type AgentJobKind } from "../model-config/types.js";

function isAgentJobKind(value: unknown): value is AgentJobKind {
  return typeof value === "string" && (AGENT_JOB_KINDS as readonly string[]).includes(value);
}

/**
 * The only place decrypted project secrets ever leave the API process —
 * called by the Orchestrator at dispatch time (ADR 003 §16), never by
 * session-authenticated (user-facing) routes.
 */
export function createSecretsInternalRouter(deps: {
  secrets: SecretRepository;
  projects: ProjectRepository;
  features: FeatureRepository;
  providers: OrgProviderRepository;
  models: OrgModelRepository;
  jobDefaults: JobModelDefaultRepository;
  projectOverrides: ProjectModelOverrideRepository;
  featureOverrides: FeatureJobModelOverrideRepository;
  featureSecrets: FeatureModelSecretRepository;
}): Router {
  const router = Router();

  const resolutionDeps = (): ModelConfigResolutionDeps => ({
    secrets: deps.secrets,
    featureSecrets: deps.featureSecrets,
    providers: deps.providers,
    models: deps.models,
    jobDefaults: deps.jobDefaults,
    projectOverrides: deps.projectOverrides,
    featureOverrides: deps.featureOverrides,
  });

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

      // jobKind is only meaningful for the 5 agent-driven kinds (ADR 018);
      // non-agent kinds (deploy, script_test_run) fetch other project
      // secrets without any model config overlay.
      const jobKind = req.query.jobKind;
      // featureId is optional and additive (ADR 018 amendment, issue #5): a
      // feature-owned job passes it so the feature tier takes part in
      // resolution. Absent, resolution is exactly what it was before the
      // feature tier existed, so an older Orchestrator keeps working.
      const featureIdParam = req.query.featureId;
      const featureId =
        typeof featureIdParam === "string" && isUuid(featureIdParam) ? featureIdParam : null;
      const belongsToProject =
        featureId !== null ? await deps.features.findById(project.id, featureId) : null;
      const secrets = await deps.secrets.decryptAllForProject(projectId);

      if (isAgentJobKind(jobKind)) {
        const modelConfig = await resolveModelConfigForJob(
          resolutionDeps(),
          projectId,
          project.organizationId,
          jobKind,
          belongsToProject ? featureId : null,
        );
        if (modelConfig) {
          for (const key of MODEL_CONFIG_KEYS) {
            secrets[key] = modelConfig[key];
          }
        } else {
          for (const key of MODEL_CONFIG_KEYS) {
            delete secrets[key];
          }
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
