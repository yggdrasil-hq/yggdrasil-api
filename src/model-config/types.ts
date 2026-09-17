/** ADR 018: the five agent-driven job kinds that resolve a model config. */
export const AGENT_JOB_KINDS = [
  "spec_grill",
  "feature_build",
  "test_run",
  "agentic_review",
  "design_grill",
] as const;
export type AgentJobKind = (typeof AGENT_JOB_KINDS)[number];

export const PROVIDER_TYPES = ["openrouter", "anthropic", "custom_openai_compatible"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

/** Known-type default base URLs; admins may still override them (ADR 018 item 1). */
export const DEFAULT_PROVIDER_BASE_URLS: Record<Exclude<ProviderType, "custom_openai_compatible">, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
};

export interface OrgProvider {
  id: string;
  organizationId: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrgModel {
  id: string;
  organizationId: string;
  providerId: string;
  providerName: string;
  providerType: ProviderType;
  displayName: string;
  modelId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobModelDefault {
  organizationId: string;
  jobKind: AgentJobKind;
  modelId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectJobModelOverride {
  projectId: string;
  jobKind: AgentJobKind;
  modelId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * ADR 018 amendment (issue #5): the feature tier's catalog override, mirroring
 * ProjectJobModelOverride one level down. Presence of a row means override;
 * absence means inherit the project/org tiers.
 */
export interface FeatureJobModelOverride {
  featureId: string;
  jobKind: AgentJobKind;
  modelId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Which tier a job's model configuration actually resolved from, narrowest
 * first (ADR 018 amendment, issue #5). `"none"` means nothing resolved — a
 * dispatch site refuses the job, exactly as before.
 *
 * This is the *source* of a resolution, deliberately separated from the
 * resolution's values: the source is safe to show a user (the feature page
 * says "inherited from Acme Retail's default"), the values never are
 * (MODEL_API_KEY in particular).
 */
export const MODEL_CONFIG_SOURCES = [
  "feature_custom",
  "feature_override",
  "project_custom",
  "project_override",
  "organization_default",
  "none",
] as const;
export type ModelConfigSource = (typeof MODEL_CONFIG_SOURCES)[number];

/** The tier a resolution came from, plus the catalog model it selected when that tier is catalog-based. */
export interface ModelConfigSourceResolution {
  source: ModelConfigSource;
  /** Set only for the three catalog tiers; null for custom-triplet tiers and `"none"`. */
  modelId: string | null;
}

export interface ResolvedModelConfig {
  MODEL_BASE_URL: string;
  MODEL_API_KEY: string;
  MODEL_ID: string;
}

/** A resolved config plus where it came from (ADR 018 amendment, issue #5). */
export interface ModelConfigResolution extends ModelConfigSourceResolution {
  config: ResolvedModelConfig | null;
}
