import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createFeatureModelConfigRouter } from "./feature-routes.js";
import type { SessionRecord } from "../auth/sessions.js";
import type { Feature } from "../features/types.js";
import type { Project } from "../projects/types.js";
import type { User } from "../users/types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const FEATURE_ID = "44444444-4444-4444-8444-444444444444";
const MODEL_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_MODEL_ID = "66666666-6666-4666-8666-666666666666";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    organizationId: ORG_ID,
    name: "Acme Retail",
    slug: "acme-retail",
    description: "",
    status: "ready",
    ...overrides,
  } as Project;
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: FEATURE_ID,
    projectId: PROJECT_ID,
    title: "Checkout redesign",
    slug: "checkout-redesign",
    status: "draft",
    ...overrides,
  } as Feature;
}

/**
 * Mirrors organizations/routes.test.ts's fakes-only shape — no database. The
 * resolvers here are the real ones (secrets/model-config.ts), only their
 * repositories are faked, so these tests exercise the actual precedence ladder.
 */
function buildApp(
  overrides: {
    /** null => the caller has no access to the project (not a member / not found). */
    project?: Project | null;
    /** null => the feature doesn't belong to that project. */
    feature?: Feature | null;
    featureSecrets?: Record<string, string>;
    featureOverrideModelId?: string | null;
    projectSecrets?: Record<string, string>;
    projectOverrideModelId?: string | null;
    orgDefaultModelId?: string | null;
  } = {},
) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const users = {
    findById: vi.fn(async () => ({ id: USER_ID } as User)),
  };
  const sessions = {
    findValid: vi.fn(async () => ({ id: "sess_1", userId: USER_ID } as SessionRecord)),
    touch: vi.fn(async () => undefined),
  };
  const projects = {
    findByIdForUser: vi.fn(async () =>
      overrides.project === undefined ? makeProject() : overrides.project,
    ),
    findById: vi.fn(async () => (overrides.project === undefined ? makeProject() : overrides.project)),
  };
  const features = {
    findById: vi.fn(async () =>
      overrides.feature === undefined ? makeFeature() : overrides.feature,
    ),
  };
  const models = {
    findById: vi.fn(async (_orgId: string, modelId: string) =>
      modelId === MODEL_ID
        ? {
            id: MODEL_ID,
            organizationId: ORG_ID,
            providerId: "provider_1",
            providerName: "OpenRouter",
            providerType: "openrouter",
            displayName: "Claude Sonnet 5",
            modelId: "claude-sonnet-5",
            createdAt: new Date(),
            updatedAt: new Date(),
          }
        : modelId === OTHER_MODEL_ID
          ? {
              id: OTHER_MODEL_ID,
              organizationId: ORG_ID,
              providerId: "provider_1",
              providerName: "OpenRouter",
              providerType: "openrouter",
              displayName: "GPT-4.1",
              modelId: "gpt-4.1",
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null,
    ),
  };
  const featureOverrides = {
    listForFeature: vi.fn(async () => []),
    findForJobKind: vi.fn(async () =>
      overrides.featureOverrideModelId ? { modelId: overrides.featureOverrideModelId } : null,
    ),
    upsert: vi.fn(async (featureId: string, jobKind: string, modelId: string) => ({
      featureId,
      jobKind,
      modelId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    clear: vi.fn(async () => true),
  };
  const featureSecrets = {
    listForFeature: vi.fn(async () =>
      Object.keys(overrides.featureSecrets ?? {}).map((key, index) => ({
        id: `sec_${index}`,
        key,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    ),
    upsert: vi.fn(async (_featureId: string, key: string) => ({
      id: `sec_${key}`,
      key,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    delete: vi.fn(async () => true),
    decryptAllForFeature: vi.fn(async () => ({ ...(overrides.featureSecrets ?? {}) })),
  };

  app.use(
    "/projects",
    createFeatureModelConfigRouter({
      users: users as never,
      sessions: sessions as never,
      projects: projects as never,
      features: features as never,
      models: models as never,
      featureOverrides: featureOverrides as never,
      featureSecrets: featureSecrets as never,
      resolution: {
        secrets: {
          decryptAllForProject: vi.fn(async () => ({ ...(overrides.projectSecrets ?? {}) })),
        } as never,
        providers: {
          decryptApiKey: vi.fn(async () => "org-key"),
          findById: vi.fn(async () => ({ id: "provider_1", baseUrl: "https://org.example/v1" })),
        } as never,
        models: models as never,
        jobDefaults: {
          findForJobKind: vi.fn(async () =>
            overrides.orgDefaultModelId ? { modelId: overrides.orgDefaultModelId } : null,
          ),
        } as never,
        projectOverrides: {
          findForJobKind: vi.fn(async () =>
            overrides.projectOverrideModelId ? { modelId: overrides.projectOverrideModelId } : null,
          ),
        } as never,
      },
    }),
  );

  return { app, featureOverrides, featureSecrets };
}

const SESSION_COOKIE = "yggdrasil_session=sess_1";

function authedRequest(app: express.Express) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", SESSION_COOKIE),
    put: (url: string) => request(app).put(url).set("Cookie", SESSION_COOKIE),
    delete: (url: string) => request(app).delete(url).set("Cookie", SESSION_COOKIE),
  };
}

const BASE = `/projects/${PROJECT_ID}/features/${FEATURE_ID}`;

describe("feature model-config router — effective configuration (ADR 018 amendment, issue #5)", () => {
  it("reports every job kind as inheriting the org default when nothing narrower is set", async () => {
    const { app } = buildApp({ orgDefaultModelId: MODEL_ID });

    const res = await authedRequest(app).get(`${BASE}/model-config`);

    expect(res.status).toBe(200);
    expect(res.body.customTripletSet).toBe(false);
    expect(res.body.jobKinds).toHaveLength(5);
    for (const entry of res.body.jobKinds) {
      expect(entry.source).toBe("organization_default");
      expect(entry.modelDisplayName).toBe("Claude Sonnet 5");
      expect(entry.providerName).toBe("OpenRouter");
    }
  });

  it("reports a feature catalog override as winning over the project and org tiers", async () => {
    const { app } = buildApp({
      featureOverrideModelId: MODEL_ID,
      projectOverrideModelId: OTHER_MODEL_ID,
      orgDefaultModelId: OTHER_MODEL_ID,
    });

    const res = await authedRequest(app).get(`${BASE}/model-config`);

    expect(res.status).toBe(200);
    const specGrill = res.body.jobKinds.find((k: { jobKind: string }) => k.jobKind === "spec_grill");
    expect(specGrill.source).toBe("feature_override");
    expect(specGrill.modelId).toBe(MODEL_ID);
    expect(specGrill.modelDisplayName).toBe("Claude Sonnet 5");
  });

  it("labels an inherited project custom triplet as such, without exposing its values", async () => {
    const { app } = buildApp({
      projectSecrets: {
        MODEL_BASE_URL: "https://project.example/v1",
        MODEL_API_KEY: "sk-project-secret",
        MODEL_ID: "project-model",
      },
      orgDefaultModelId: MODEL_ID,
    });

    const res = await authedRequest(app).get(`${BASE}/model-config`);

    expect(res.status).toBe(200);
    const entry = res.body.jobKinds[0];
    expect(entry.source).toBe("project_custom");
    expect(entry.modelDisplayName).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain("sk-project-secret");
  });

  it("marks the custom triplet as set only when all three keys are present", async () => {
    const { app } = buildApp({
      featureSecrets: {
        MODEL_BASE_URL: "https://feature.example/v1",
        MODEL_API_KEY: "sk-feature",
        MODEL_ID: "feature-model",
      },
    });

    const res = await authedRequest(app).get(`${BASE}/model-config`);

    expect(res.status).toBe(200);
    expect(res.body.customTripletSet).toBe(true);
    expect(res.body.jobKinds[0].source).toBe("feature_custom");
    expect(JSON.stringify(res.body)).not.toContain("sk-feature");
  });
});

describe("feature model-config router — authorization", () => {
  it("404s the effective-config read for a project the caller can't access", async () => {
    const { app } = buildApp({ project: null });

    const res = await authedRequest(app).get(`${BASE}/model-config`);

    expect(res.status).toBe(404);
  });

  it("404s when the feature belongs to a different project", async () => {
    const { app } = buildApp({ feature: null });

    const res = await authedRequest(app).get(`${BASE}/model-config`);

    expect(res.status).toBe(404);
  });

  it("404s a catalog-override write for a feature the caller can't reach", async () => {
    const { app, featureOverrides } = buildApp({ feature: null });

    const res = await authedRequest(app)
      .put(`${BASE}/job-model-overrides/spec_grill`)
      .send({ modelId: MODEL_ID });

    expect(res.status).toBe(404);
    expect(featureOverrides.upsert).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID feature id without touching the repositories", async () => {
    const { app } = buildApp();

    const res = await authedRequest(app).get(`/projects/${PROJECT_ID}/features/not-a-uuid/model-config`);

    expect(res.status).toBe(404);
  });
});

describe("feature model-config router — catalog override", () => {
  it("sets an override for one job kind using a model from the project's org", async () => {
    const { app, featureOverrides } = buildApp();

    const res = await authedRequest(app)
      .put(`${BASE}/job-model-overrides/spec_grill`)
      .send({ modelId: MODEL_ID });

    expect(res.status).toBe(200);
    expect(res.body.jobKind).toBe("spec_grill");
    expect(featureOverrides.upsert).toHaveBeenCalledWith(FEATURE_ID, "spec_grill", MODEL_ID);
  });

  it("rejects a model that isn't in the org's catalog", async () => {
    const { app, featureOverrides } = buildApp();

    const res = await authedRequest(app)
      .put(`${BASE}/job-model-overrides/spec_grill`)
      .send({ modelId: "77777777-7777-4777-8777-777777777777" });

    expect(res.status).toBe(400);
    expect(featureOverrides.upsert).not.toHaveBeenCalled();
  });

  it("rejects an unknown job kind", async () => {
    const { app } = buildApp();

    const res = await authedRequest(app)
      .put(`${BASE}/job-model-overrides/deploy`)
      .send({ modelId: MODEL_ID });

    expect(res.status).toBe(400);
  });

  it("clears an override back to inherit", async () => {
    const { app, featureOverrides } = buildApp();

    const res = await authedRequest(app).delete(`${BASE}/job-model-overrides/spec_grill`);

    expect(res.status).toBe(204);
    expect(featureOverrides.clear).toHaveBeenCalledWith(FEATURE_ID, "spec_grill");
  });
});

describe("feature model-config router — custom triplet (all-or-nothing)", () => {
  const COMPLETE = {
    modelBaseUrl: "https://feature.example/v1",
    modelApiKey: "sk-feature",
    modelId: "feature-model",
  };

  it("writes all three keys as one bundle", async () => {
    const { app, featureSecrets } = buildApp();

    const res = await authedRequest(app).put(`${BASE}/model-secrets`).send(COMPLETE);

    expect(res.status).toBe(200);
    expect(featureSecrets.upsert).toHaveBeenCalledTimes(3);
    expect(featureSecrets.upsert).toHaveBeenCalledWith(FEATURE_ID, "MODEL_BASE_URL", COMPLETE.modelBaseUrl);
    expect(featureSecrets.upsert).toHaveBeenCalledWith(FEATURE_ID, "MODEL_API_KEY", COMPLETE.modelApiKey);
    expect(featureSecrets.upsert).toHaveBeenCalledWith(FEATURE_ID, "MODEL_ID", COMPLETE.modelId);
  });

  it("rejects a partial triplet — base URL and model ID only", async () => {
    const { app, featureSecrets } = buildApp();

    const res = await authedRequest(app)
      .put(`${BASE}/model-secrets`)
      .send({ modelBaseUrl: COMPLETE.modelBaseUrl, modelId: COMPLETE.modelId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/all three values/i);
    expect(featureSecrets.upsert).not.toHaveBeenCalled();
  });

  it("rejects an empty API key rather than storing an unusable triplet", async () => {
    const { app, featureSecrets } = buildApp();

    const res = await authedRequest(app)
      .put(`${BASE}/model-secrets`)
      .send({ ...COMPLETE, modelApiKey: "   " });

    expect(res.status).toBe(400);
    expect(featureSecrets.upsert).not.toHaveBeenCalled();
  });

  it("clears the whole triplet back to inherit", async () => {
    const { app, featureSecrets } = buildApp({
      featureSecrets: {
        MODEL_BASE_URL: COMPLETE.modelBaseUrl,
        MODEL_API_KEY: COMPLETE.modelApiKey,
        MODEL_ID: COMPLETE.modelId,
      },
    });

    const res = await authedRequest(app).delete(`${BASE}/model-secrets`);

    expect(res.status).toBe(204);
    expect(featureSecrets.delete).toHaveBeenCalledTimes(3);
  });

  it("lists the keys that are set, never their values", async () => {
    const { app } = buildApp({
      featureSecrets: { MODEL_API_KEY: COMPLETE.modelApiKey },
    });

    const res = await authedRequest(app).get(`${BASE}/model-secrets`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "sec_0", key: "MODEL_API_KEY", createdAt: expect.any(String), updatedAt: expect.any(String) },
    ]);
  });

  it("404s a triplet write for a feature the caller can't reach", async () => {
    const { app, featureSecrets } = buildApp({ project: null });

    const res = await authedRequest(app).put(`${BASE}/model-secrets`).send(COMPLETE);

    expect(res.status).toBe(404);
    expect(featureSecrets.upsert).not.toHaveBeenCalled();
  });
});
