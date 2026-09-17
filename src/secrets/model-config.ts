import type { SecretRepository } from "./repository.js";
import type { FeatureModelSecretRepository } from "./feature-model-repository.js";
import type { OrgProviderRepository } from "../model-config/provider-repository.js";
import type { OrgModelRepository } from "../model-config/model-repository.js";
import type { JobModelDefaultRepository } from "../model-config/job-default-repository.js";
import type { ProjectModelOverrideRepository } from "../model-config/project-override-repository.js";
import type { FeatureJobModelOverrideRepository } from "../model-config/feature-override-repository.js";
import type {
  AgentJobKind,
  ModelConfigResolution,
  ModelConfigSourceResolution,
  ResolvedModelConfig,
} from "../model-config/types.js";

/**
 * The three keys are one unit (ADR 007, kept under ADR 016/018): a project or
 * feature has none of them set at its own level (fully inherits its resolved
 * config) or all three (fully custom) — never a per-key mix.
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
 * Every repository `resolveModelConfigSource` needs. `featureId` is optional at
 * the call-site level (a job without a feature — `deploy`, a project-scoped
 * `design_grill` — simply skips the feature tier), but the repositories
 * themselves are always required.
 */
export interface ModelConfigResolutionDeps {
  secrets: SecretRepository;
  featureSecrets: FeatureModelSecretRepository;
  providers: OrgProviderRepository;
  models: OrgModelRepository;
  jobDefaults: JobModelDefaultRepository;
  projectOverrides: ProjectModelOverrideRepository;
  featureOverrides: FeatureJobModelOverrideRepository;
}

/**
 * Resolves *which tier* a job's model configuration comes from, per the ADR 018
 * amendment (issue #5), narrowest first:
 *
 *   1. the feature's own custom triplet (all three keys present in
 *      feature_model_secrets);
 *   2. the feature's catalog override for this job kind;
 *   3. the project's own custom triplet (all three keys present in
 *      project_secrets) — the escape hatch kept from ADR 007/016;
 *   4. the project's catalog override for this job kind;
 *   5. the organization's default model for this job kind;
 *   6. `"none"` if nothing resolves.
 *
 * Deliberately decrypts nothing: this is the whole precedence ladder in one
 * place, and the two consumers differ only in what they do with the answer —
 * dispatch resolves the winner's values (resolveModelConfigForJobWithSource),
 * while the feature-model-config read endpoint reports the winner to the user
 * (describeModelConfigResolution).
 *
 * A *partial* custom triplet at either the feature or the project tier is
 * treated as unresolvable (`"none"`) rather than silently falling through —
 * that would mask an inconsistent state instead of surfacing it. The API
 * enforces all-or-nothing on write, so this only triggers on data that got in
 * some other way.
 */
export async function resolveModelConfigSource(
  deps: ModelConfigResolutionDeps,
  input: {
    projectId: string;
    organizationId: string;
    jobKind: AgentJobKind;
    /** Absent/null for jobs with no owning feature. */
    featureId?: string | null;
  },
): Promise<ModelConfigSourceResolution> {
  const { projectId, organizationId, jobKind, featureId } = input;

  if (featureId) {
    const featureSecrets = await deps.featureSecrets.decryptAllForFeature(featureId);
    if (extractModelConfigBundle(featureSecrets)) {
      return { source: "feature_custom", modelId: null };
    }
    if (MODEL_CONFIG_KEYS.some((key) => featureSecrets[key])) {
      return { source: "none", modelId: null };
    }

    const featureOverride = await deps.featureOverrides.findForJobKind(featureId, jobKind);
    if (featureOverride) {
      return { source: "feature_override", modelId: featureOverride.modelId };
    }
  }

  const projectSecrets = await deps.secrets.decryptAllForProject(projectId);
  if (extractModelConfigBundle(projectSecrets)) {
    return { source: "project_custom", modelId: null };
  }
  if (MODEL_CONFIG_KEYS.some((key) => projectSecrets[key])) {
    return { source: "none", modelId: null };
  }

  const projectOverride = await deps.projectOverrides.findForJobKind(projectId, jobKind);
  if (projectOverride) {
    return { source: "project_override", modelId: projectOverride.modelId };
  }

  const orgDefault = await deps.jobDefaults.findForJobKind(organizationId, jobKind);
  if (orgDefault) {
    return { source: "organization_default", modelId: orgDefault.modelId };
  }

  return { source: "none", modelId: null };
}

/**
 * The dispatch-time resolution: the winning tier's *values*, ready to become
 * job-pod env vars. Builds on resolveModelConfigSource, so the precedence rules
 * live in exactly one place.
 *
 * Returns null when nothing resolves (source `"none"`) — the dispatch gates
 * treat that as "refuse the job".
 */
export async function resolveModelConfigForJobWithSource(
  deps: ModelConfigResolutionDeps,
  input: {
    projectId: string;
    organizationId: string;
    jobKind: AgentJobKind;
    featureId?: string | null;
  },
): Promise<ModelConfigResolution> {
  const { source, modelId } = await resolveModelConfigSource(deps, input);

  if (source === "none") {
    return { source, modelId: null, config: null };
  }
  if (source === "feature_custom") {
    const bundle = extractModelConfigBundle(
      await deps.featureSecrets.decryptAllForFeature(input.featureId!),
    );
    return { source, modelId: null, config: bundle };
  }
  if (source === "project_custom") {
    const bundle = extractModelConfigBundle(
      await deps.secrets.decryptAllForProject(input.projectId),
    );
    return { source, modelId: null, config: bundle };
  }

  const config = modelId
    ? await resolveOrgModelConfig(deps, input.organizationId, modelId)
    : null;
  return { source, modelId, config };
}

/**
 * Resolves the model configuration a dispatch site should use for a job, per
 * the ADR 018 amendment (issue #5). Thin wrapper over
 * resolveModelConfigForJobWithSource for callers that don't care which tier won.
 */
export async function resolveModelConfigForJob(
  deps: ModelConfigResolutionDeps,
  projectId: string,
  organizationId: string,
  jobKind: AgentJobKind,
  featureId?: string | null,
): Promise<ResolvedModelConfig | null> {
  const resolution = await resolveModelConfigForJobWithSource(deps, {
    projectId,
    organizationId,
    jobKind,
    featureId,
  });
  return resolution.config;
}
