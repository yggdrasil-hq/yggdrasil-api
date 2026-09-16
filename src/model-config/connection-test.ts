import type { ProviderType } from "./types.js";

/**
 * ADR 018: lightweight reachability check for a provider's credentials.
 * Hits each provider's models-list endpoint — cheap, read-only, and works
 * for a custom OpenAI-compatible base URL too since that's part of the spec.
 */
export async function testProviderConnection(input: {
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
}): Promise<{ ok: boolean; error?: string }> {
  const url = new URL("models", input.baseUrl.replace(/\/?$/, "/")).toString();
  const headers: Record<string, string> =
    input.providerType === "anthropic"
      ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${input.apiKey}` };

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "The provider rejected the API key" };
    }
    return { ok: false, error: `Provider responded with ${response.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  }
}
