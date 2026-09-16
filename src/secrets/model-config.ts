import type { SecretRepository } from "./repository.js";
import type { OrgProviderRepository } from "../model-config/provider-repository.js";
import type { OrgModelRepository } from "../model-config/model-repository.js";
import type { JobModelDefaultRepository } from "../model-config/job-default-repository.js";
import type { ProjectModelOverrideRepository } from "../model-config/project-override-repository.js";
import type { AgentJobKind, ResolvedModelConfig } from "../model-config/types.js";

/**
 * The three keys are one unit (ADR 007, kept under ADR 016/018): a project has
 * none of them set at the project level (fully inherits its resolved config)
 * or all three (fully custom) — never a per-key mix.
 */
export const MODEL_CONFIG_KEYS = ["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_ID"] as const;

export type ModelConfigKey = (typeof MODEL_CONFIG_KEYS)[number];
export type ModelConfigBundle = Record<ModelConfigKey, string>;

/** Extracts the model-config bundle from a secrets map, or null if any of the three keys is missing/empty. */
export function extractModelConfigBundle(
  secrets: Record<string, string>,
): ModelConfigBundle | null {
  const bundle = {} as ModelConfigBundle;
  for (const key of MODEL_CONFIG_KEYS) {
    const value = secrets[key];
    if (!value) {
      return null;
    }
    bundle[key] = value;
  }
  return bundle;
}

/** Resolves a specific catalog model's provider into a pod-env-var-shaped bundle. Exported for the project-creation flow, which needs to preview an org's default before a project exists. */
export async function resolveOrgModelConfig(
  deps: { providers: OrgProviderRepository; models: OrgModelRepository },
  organizationId: string,
  modelId: string,
): Promise<ResolvedModelConfig | null> {
  const model = await deps.models.findById(organizationId, modelId);
  if (!model) {
    return null;
  }
  const apiKey = await deps.providers.decryptApiKey(model.providerId);
  const provider = await deps.providers.findById(organizationId, model.providerId);
  if (!apiKey || !provider) {
    return null;
  }
  return {
    MODEL_BASE_URL: provider.baseUrl,
    MODEL_API_KEY: apiKey,
    MODEL_ID: model.modelId,
  };
}

/**
 * Resolves the model configuration a dispatch site should use for a project's
 * job, per ADR 018 items 5-6, in order:
 *
 *   1. the project's own custom triplet (all three keys present in
 *      project_secrets) — the escape hatch kept from ADR 007/016;
 *   2. the project's catalog override for this job kind, if any;
 *   3. the organization's default model for this job kind;
 *   4. null if nothing resolves.
 *
 * A project with a *partial* custom triplet (shouldn't happen via the API,
 * which enforces all-or-nothing on write) is treated as unresolvable at that
 * step rather than silently falling through — that would mask an
 * inconsistent state instead of surfacing it.
 */
export async function resolveModelConfigForJob(
  deps: {
    secrets: SecretRepository;
    providers: OrgProviderRepository;
    models: OrgModelRepository;
    jobDefaults: JobModelDefaultRepository;
    projectOverrides: ProjectModelOverrideRepository;
  },
  projectId: string,
  organizationId: string,
  jobKind: AgentJobKind,
): Promise<ResolvedModelConfig | null> {
  const projectSecrets = await deps.secrets.decryptAllForProject(projectId);
  const customBundle = extractModelConfigBundle(projectSecrets);
  if (customBundle) {
    return customBundle;
  }
  const hasPartialCustomBundle = MODEL_CONFIG_KEYS.some((key) => projectSecrets[key]);
  if (hasPartialCustomBundle) {
    return null;
  }

  const projectOverride = await deps.projectOverrides.findForJobKind(projectId, jobKind);
  if (projectOverride) {
    return resolveOrgModelConfig(deps, organizationId, projectOverride.modelId);
  }

  const orgDefault = await deps.jobDefaults.findForJobKind(organizationId, jobKind);
  if (orgDefault) {
    return resolveOrgModelConfig(deps, organizationId, orgDefault.modelId);
  }

  return null;
}
