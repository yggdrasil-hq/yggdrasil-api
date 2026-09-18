import type { ProviderType } from "./types.js";

/**
 * ADR 018: the one client for a provider's HTTP API.
 *
 * Both things the API does with a provider — check that its credentials work,
 * and list the models it serves — are the same request against the same
 * endpoint with the same per-provider authentication. Issue #36 calls this out
 * explicitly: they must not each build the URL and headers, or they will drift
 * the first time a provider's auth differs (Anthropic's `x-api-key` +
 * `anthropic-version` versus OpenAI's bearer token is exactly the kind of thing
 * that gets fixed in one copy and not the other).
 *
 * **The session header (issue #37).** Every provider request carries
 * `x-opencode-session`. The gateway this product is deployed against routes by
 * it and refuses a request without one:
 *
 *   400 {"type":"MissingSessionID","message":"Error from provider (Console Go):
 *        Request is missing x-opencode-session and cannot be routed efficiently."}
 *
 * It is sent unconditionally rather than behind an "are you behind a gateway"
 * setting, because a provider with no use for it ignores an unrecognised header
 * — so sending it is free where it does nothing and required where it does
 * something. The same header is set by the job pods through
 * `agent-images/models.json.template` (whose value is the job id, from the
 * Orchestrator's `MODEL_SESSION_ID`); this module is the API's copy, and the
 * three cannot import each other, so the name is a contract each side names in
 * a comment.
 *
 * The value here is per-*component* rather than per-run: an admin probing
 * credentials is not a run, and inventing a run id for it would put a
 * meaningless identifier into the gateway's cost breakdown.
 */

/** Issue #37's gateway attribution header. Mirrored in `agent-images`. */
export const MODEL_SESSION_HEADER = "x-opencode-session";

/**
 * The session value the API sends when it is not acting on behalf of a run.
 * Fixed rather than random: a gateway's breakdown should show one "the API
 * itself did this" bucket, not one per request.
 */
export const API_SESSION_ID = "yggdrasil-api";

export interface ProviderModel {
  /** The provider's own identifier — what a job sends as `MODEL_ID`. */
  id: string;
  /** The provider's label for it, when it offers one distinct from the id. */
  displayName: string | null;
}

export interface ProviderRequestInput {
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
}

/** The request headers for a provider, including the auth scheme and #37's session header. */
export function providerRequestHeaders(input: {
  providerType: ProviderType;
  apiKey: string;
}): Record<string, string> {
  return {
    ...(input.providerType === "anthropic"
      ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${input.apiKey}` }),
    [MODEL_SESSION_HEADER]: API_SESSION_ID,
  };
}

/**
 * The models-list URL. `models` relative to the configured base URL, so a
 * custom OpenAI-compatible endpoint works without a second setting — the same
 * rule the OpenAI and Anthropic defaults satisfy.
 */
export function providerModelsUrl(baseUrl: string): string {
  return new URL("models", baseUrl.replace(/\/?$/, "/")).toString();
}

/**
 * Maps a provider's models response to what the catalog needs.
 *
 * One mapping for both shapes the product supports, because they overlap: an
 * OpenAI-compatible list is `data[].id`, and Anthropic's is `data[].id` plus an
 * optional `display_name`. A provider that offers no label gets null rather than
 * the id repeated — "the admin has not written one" is a real state the catalog
 * row distinguishes.
 *
 * Returns null for a payload with no `data` array, so a provider answering with
 * something else is reported as unreadable rather than as an empty catalog —
 * an empty dropdown and a failed listing are different problems, and issue #36
 * asks for the second to say so.
 */
export function parseProviderModels(payload: unknown): ProviderModel[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;

  const models: ProviderModel[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { id?: unknown; display_name?: unknown; name?: unknown };
    if (typeof record.id !== "string" || record.id.trim() === "") continue;
    const label =
      typeof record.display_name === "string" && record.display_name.trim() !== ""
        ? record.display_name
        : typeof record.name === "string" && record.name.trim() !== ""
          ? record.name
          : null;
    models.push({ id: record.id, displayName: label });
  }

  return models;
}

/**
 * A failed provider call, phrased for an admin deciding what to do next. Kept
 * in one place because both callers show it, and "The provider rejected the API
 * key" is a different instruction from "Provider responded with 503".
 */
function describeFailure(status: number): string {
  if (status === 401 || status === 403) return "The provider rejected the API key";
  if (status === 404) return "The provider has no models endpoint at that base URL";
  return `Provider responded with ${status}`;
}

/** The raw call both public functions share. */
async function fetchModels(input: ProviderRequestInput): Promise<
  { ok: true; models: ProviderModel[] } | { ok: false; error: string }
> {
  try {
    const response = await fetch(providerModelsUrl(input.baseUrl), {
      method: "GET",
      headers: providerRequestHeaders(input),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { ok: false, error: describeFailure(response.status) };

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, error: "The provider's models response was not JSON" };
    }

    const models = parseProviderModels(payload);
    if (!models) {
      return { ok: false, error: "The provider's models response was not recognised" };
    }
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Connection failed" };
  }
}

/**
 * ADR 018: lightweight reachability check for a provider's credentials.
 *
 * Deliberately still answered from the models endpoint rather than a cheaper
 * ping: it is the same request the listing makes, so a provider that passes the
 * check is one whose listing will work.
 */
export async function testProviderConnection(
  input: ProviderRequestInput,
): Promise<{ ok: boolean; error?: string }> {
  const result = await fetchModels(input);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Issue #36: the models a configured provider actually serves, for the catalog's
 * model field. Sorted by id so a dropdown has a stable order rather than
 * whatever the provider happened to return.
 */
export async function listProviderModels(
  input: ProviderRequestInput,
): Promise<{ ok: true; models: ProviderModel[] } | { ok: false; error: string }> {
  const result = await fetchModels(input);
  if (!result.ok) return result;
  return {
    ok: true,
    models: [...result.models].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
