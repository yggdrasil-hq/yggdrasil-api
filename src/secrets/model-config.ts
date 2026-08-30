import type { SecretRepository } from "./repository.js";
import type { OrgSecretRepository } from "../organizations/org-secrets-repository.js";

/**
 * The three keys are one unit (ADR 007, kept under ADR 016): a project has
 * none of them set at the project level (fully inherits its Organization's
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

/**
 * Resolves the model configuration a dispatch site should use for a project,
 * per ADR 016 items 8-9: the project's own bundle first, fully inheriting its
 * owning Organization's config otherwise. There is no per-user fallback tier
 * (ADR 007 is retired). A project with a *partial* set of the three keys
 * (shouldn't happen via the API, which enforces all-or-nothing on write) is
 * treated as unresolvable rather than silently falling back — that would mask
 * an inconsistent state instead of surfacing it.
 */
export async function resolveModelConfig(
  deps: { secrets: SecretRepository; orgSecrets: OrgSecretRepository },
  projectId: string,
  organizationId: string,
): Promise<ModelConfigBundle | null> {
  const projectSecrets = await deps.secrets.decryptAllForProject(projectId);
  const projectBundle = extractModelConfigBundle(projectSecrets);
  if (projectBundle) {
    return projectBundle;
  }

  const hasPartialProjectOverride = MODEL_CONFIG_KEYS.some((key) => projectSecrets[key]);
  if (hasPartialProjectOverride) {
    return null;
  }

  const orgSecrets = await deps.orgSecrets.decryptAllForOrganization(organizationId);
  return extractModelConfigBundle(orgSecrets);
}