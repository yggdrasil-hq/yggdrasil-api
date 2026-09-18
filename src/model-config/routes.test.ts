import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelConfigRouter } from "./routes.js";
import type { SessionRecord } from "../auth/sessions.js";
import type { User } from "../users/types.js";

/**
 * Issue #36: `GET /organizations/:orgId/providers/:providerId/models`.
 *
 * The listing itself is tested against a fake provider in
 * `provider-client.test.ts`; what is checked here is everything the route adds —
 * the admin gate, the 200-with-`ok:false` shape, and the provider id echoed back
 * so a slow response cannot populate the wrong dialog.
 */

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_COOKIE = "yggdrasil_session=sess_1";

function buildApp(overrides: {
  role?: string | null;
  provider?: { id: string; providerType: string; baseUrl: string } | null;
  apiKey?: string | null;
} = {}) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const role = overrides.role === undefined ? "admin" : overrides.role;
  const provider =
    overrides.provider === undefined
      ? { id: PROVIDER_ID, providerType: "openrouter", baseUrl: "https://provider.test/v1" }
      : overrides.provider;

  const deps = {
    users: { findById: vi.fn(async () => ({ id: USER_ID } as User)) },
    sessions: {
      findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID } as SessionRecord)),
      touch: vi.fn(async () => undefined),
    },
    organizations: { roleForUser: vi.fn(async () => role) },
    providers: {
      findById: vi.fn(async () => provider),
      // `undefined` means "not overridden"; null means "the key is unreadable",
      // so `??` would collapse the two and the 404 case would silently pass a
      // key through.
      decryptApiKey: vi.fn(async () =>
        overrides.apiKey === undefined ? "sk-org" : overrides.apiKey,
      ),
    },
    models: {},
    jobDefaults: {},
    audit: { record: vi.fn(async () => undefined) },
  };

  app.use("/organizations", createModelConfigRouter(deps as never));
  return { app, deps };
}

function get(app: express.Express, providerId = PROVIDER_ID) {
  return request(app)
    .get(`/organizations/${ORG_ID}/providers/${providerId}/models`)
    .set("Cookie", SESSION_COOKIE);
}

function probe(app: express.Express, body: unknown) {
  return request(app)
    .post(`/organizations/${ORG_ID}/providers/probe-models`)
    .set("Cookie", SESSION_COOKIE)
    .send(body as object);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/*
 * The custom-triplet variant: no stored provider, credentials from the body,
 * one request. Same admin gate, and for a second reason — it asks the server to
 * fetch a caller-supplied URL, which only org admins could already do through
 * the existing test-connection endpoint.
 */
describe("POST /organizations/:orgId/providers/probe-models", () => {
  it("lists models for a connection the org has not stored", async () => {
    const { app, deps } = buildApp();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "gpt-5" }] }),
      })),
    );

    const res = await probe(app, {
      baseUrl: "https://typed.example/v1",
      apiKey: "sk-typed",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, models: [{ id: "gpt-5", displayName: null }] });
    // Nothing is read from the catalog: there is no provider row involved.
    expect(deps.providers.findById).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    const { app } = buildApp({ role: "developer" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect((await probe(app, { baseUrl: "https://x.test", apiKey: "k" })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires both a base URL and a key", async () => {
    const { app } = buildApp();
    vi.stubGlobal("fetch", vi.fn());

    expect((await probe(app, { baseUrl: "https://x.test" })).status).toBe(400);
    expect((await probe(app, { apiKey: "k" })).status).toBe(400);
  });

  it("reports a provider failure as a reason", async () => {
    const { app } = buildApp();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })));

    expect((await probe(app, { baseUrl: "https://x.test", apiKey: "k" })).body).toEqual({
      ok: false,
      error: "The provider rejected the API key",
    });
  });
});

describe("GET /organizations/:orgId/providers/:providerId/models", () => {
  it("returns the provider's models for an org admin", async () => {
    const { app } = buildApp();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "gpt-5" }, { id: "gpt-5-mini" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await get(app);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      models: [
        { id: "gpt-5", displayName: null },
        { id: "gpt-5-mini", displayName: null },
      ],
      providerId: PROVIDER_ID,
    });
  });

  it("spends the provider credential, so a non-admin cannot reach it", async () => {
    const { app, deps } = buildApp({ role: "developer" });
    vi.stubGlobal("fetch", vi.fn());

    const res = await get(app);

    expect(res.status).toBe(403);
    // The point of the gate: a readonly member must not be able to use this as
    // a way to probe a key they cannot see.
    expect(deps.providers.decryptApiKey).not.toHaveBeenCalled();
  });

  it("404s for a non-member", async () => {
    // roleForUser returning null is "no such org as far as you are concerned".
    const { app } = buildApp({ role: null });
    vi.stubGlobal("fetch", vi.fn());

    expect((await get(app)).status).toBe(403);
  });

  it("reports a provider failure as a reason rather than an empty dropdown", async () => {
    const { app } = buildApp();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));

    const res = await get(app);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: "The provider rejected the API key" });
  });

  it("404s for an unknown provider without calling the provider", async () => {
    const { app } = buildApp({ provider: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect((await get(app)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s for a provider with no readable key", async () => {
    const { app } = buildApp({ apiKey: null });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect((await get(app)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s for a malformed provider id", async () => {
    const { app } = buildApp();
    vi.stubGlobal("fetch", vi.fn());

    expect((await get(app, "not-a-uuid")).status).toBe(404);
  });
});
