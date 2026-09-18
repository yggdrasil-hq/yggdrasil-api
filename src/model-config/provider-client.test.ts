import { afterEach, describe, expect, it, vi } from "vitest";
import {
  API_SESSION_ID,
  MODEL_SESSION_HEADER,
  listProviderModels,
  parseProviderModels,
  providerModelsUrl,
  providerRequestHeaders,
  testProviderConnection,
} from "./provider-client.js";

/**
 * ADR 018 / issues #36 and #37: one client for a provider's HTTP API, so the
 * credential probe and the model listing cannot disagree about the URL, the
 * auth scheme, or the session header.
 */

function stubFetch(response: {
  ok?: boolean;
  status?: number;
  json?: () => Promise<unknown>;
}) {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: response.json ?? (async () => ({ data: [] })),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("providerModelsUrl", () => {
  it("resolves models against the base URL", () => {
    expect(providerModelsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/models",
    );
    expect(providerModelsUrl("https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1/models",
    );
  });
});

describe("providerRequestHeaders", () => {
  it("uses bearer auth for an OpenAI-compatible provider (openrouter)", () => {
    expect(providerRequestHeaders({ providerType: "openrouter", apiKey: "sk-1" })).toEqual({
      Authorization: "Bearer sk-1",
      [MODEL_SESSION_HEADER]: API_SESSION_ID,
    });
  });

  it("uses Anthropic's own scheme, including the version header", () => {
    expect(
      providerRequestHeaders({ providerType: "anthropic", apiKey: "sk-ant" }),
    ).toEqual({
      "x-api-key": "sk-ant",
      "anthropic-version": "2023-06-01",
      [MODEL_SESSION_HEADER]: API_SESSION_ID,
    });
  });

  // Issue #37: the gateway in front of the provider refuses a request without
  // this, and that refusal is what the product was hitting ("Request is missing
  // x-opencode-session and cannot be routed efficiently"). Every provider
  // request needs it, which is why it is not opt-in and why it is asserted for
  // both auth schemes above.
  it("always carries the gateway session header", () => {
    for (const providerType of ["anthropic", "openrouter", "custom_openai_compatible"] as const) {
      expect(providerRequestHeaders({ providerType, apiKey: "k" })[MODEL_SESSION_HEADER]).toBe(
        API_SESSION_ID,
      );
    }
  });
});

describe("parseProviderModels", () => {
  it("maps an OpenAI-compatible list", () => {
    expect(
      parseProviderModels({ data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }),
    ).toEqual([
      { id: "gpt-5", displayName: null },
      { id: "gpt-5-mini", displayName: null },
    ]);
  });

  it("maps Anthropic's list, which adds a display name", () => {
    expect(
      parseProviderModels({
        data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }],
      }),
    ).toEqual([{ id: "claude-sonnet-5", displayName: "Claude Sonnet 5" }]);
  });

  it("prefers display_name but accepts name", () => {
    expect(
      parseProviderModels({
        data: [
          { id: "a", display_name: "A", name: "ignored" },
          { id: "b", name: "B" },
        ],
      }),
    ).toEqual([
      { id: "a", displayName: "A" },
      { id: "b", displayName: "B" },
    ]);
  });

  it("skips entries with no usable id rather than inventing one", () => {
    expect(parseProviderModels({ data: [{ id: "" }, { id: 3 }, {}, { id: "real" }] })).toEqual([
      { id: "real", displayName: null },
    ]);
  });

  // The distinction the issue asks for: an empty dropdown and a failed listing
  // are different problems, and only one of them is the provider's fault.
  it("reports an unrecognised payload rather than an empty catalog", () => {
    expect(parseProviderModels({ models: ["a"] })).toBeNull();
    expect(parseProviderModels(null)).toBeNull();
    expect(parseProviderModels("nope")).toBeNull();
  });

  it("accepts a genuinely empty list", () => {
    expect(parseProviderModels({ data: [] })).toEqual([]);
  });
});

describe("testProviderConnection", () => {
  it("reports ok for a readable list", async () => {
    stubFetch({ json: async () => ({ data: [{ id: "a" }] }) });

    expect(await testProviderConnection({
      providerType: "openrouter",
      baseUrl: "https://p.test/v1",
      apiKey: "sk",
    })).toEqual({ ok: true });
  });

  it("names a rejected key as a rejected key", async () => {
    stubFetch({ ok: false, status: 401 });

    expect(
      await testProviderConnection({
        providerType: "openrouter",
        baseUrl: "https://p.test/v1",
        apiKey: "sk",
      }),
    ).toEqual({ ok: false, error: "The provider rejected the API key" });
  });

  it("reports a transport failure rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND p.test");
    }));

    const result = await testProviderConnection({
      providerType: "openrouter",
      baseUrl: "https://p.test/v1",
      apiKey: "sk",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
  });

  it("sends the session header (issue #37), which is the whole point of the probe", async () => {
    const fetchMock = stubFetch({ json: async () => ({ data: [] }) });

    await testProviderConnection({
      providerType: "openrouter",
      baseUrl: "https://p.test/v1",
      apiKey: "sk",
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers[MODEL_SESSION_HEADER]).toBe(API_SESSION_ID);
  });
});

describe("listProviderModels", () => {
  it("returns models sorted by id, so a dropdown has a stable order", async () => {
    stubFetch({
      json: async () => ({
        data: [{ id: "zeta" }, { id: "alpha" }, { id: "mid", display_name: "Mid" }],
      }),
    });

    const result = await listProviderModels({
      providerType: "openrouter",
      baseUrl: "https://p.test/v1",
      apiKey: "sk",
    });

    expect(result).toEqual({
      ok: true,
      models: [
        { id: "alpha", displayName: null },
        { id: "mid", displayName: "Mid" },
        { id: "zeta", displayName: null },
      ],
    });
  });

  it("passes a provider failure through as a reason, not an empty list", async () => {
    stubFetch({ ok: false, status: 503 });

    const result = await listProviderModels({
      providerType: "openrouter",
      baseUrl: "https://p.test/v1",
      apiKey: "sk",
    });

    expect(result).toEqual({ ok: false, error: "Provider responded with 503" });
  });

  it("distinguishes a wrong base URL from a bad key", async () => {
    stubFetch({ ok: false, status: 404 });

    const result = await listProviderModels({
      providerType: "custom_openai_compatible",
      baseUrl: "https://p.test/wrong",
      apiKey: "sk",
    });

    expect(result).toEqual({
      ok: false,
      error: "The provider has no models endpoint at that base URL",
    });
  });

  it("reports a non-JSON body as such", async () => {
    stubFetch({
      json: async () => {
        throw new Error("Unexpected token <");
      },
    });

    const result = await listProviderModels({
      providerType: "openrouter",
      baseUrl: "https://p.test/v1",
      apiKey: "sk",
    });

    expect(result).toEqual({ ok: false, error: "The provider's models response was not JSON" });
  });
});
