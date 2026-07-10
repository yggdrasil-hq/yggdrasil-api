import type { SecretRepository } from "./repository.js";
import type { UserSecretRepository } from "./user-repository.js";

/**
 * The three keys are one unit (ADR 007): a project has none of them set at
 * the project level (fully inherits the owning user's default) or all three
 * (fully custom) — never a per-key mix.
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
 * Resolves the model configuration a dispatch site should use for a project:
 * project-level bundle first, falling back to the owning user's account
 * default (ADR 007) if the project has none of the three keys set. A project
 * with a *partial* set of the three keys (shouldn't happen via the API, which
 * enforces all-or-nothing on write) is treated as unresolvable rather than
 * silently falling back — that would mask an inconsistent state instead of
 * surfacing it.
 */
export async function resolveModelConfig(
  deps: { secrets: SecretRepository; userSecrets: UserSecretRepository },
  projectId: string,
  ownerUserId: string,
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

  const userSecrets = await deps.userSecrets.decryptAllForUser(ownerUserId);
  return extractModelConfigBundle(userSecrets);
}
