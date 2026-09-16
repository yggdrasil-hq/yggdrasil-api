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

export interface ResolvedModelConfig {
  MODEL_BASE_URL: string;
  MODEL_API_KEY: string;
  MODEL_ID: string;
}
