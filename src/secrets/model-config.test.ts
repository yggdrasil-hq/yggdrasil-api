import { describe, expect, it, vi } from "vitest";
import { extractModelConfigBundle, resolveModelConfigForJob } from "./model-config.js";

const FULL_BUNDLE = {
  MODEL_BASE_URL: "https://api.openai.com/v1",
  MODEL_API_KEY: "sk-abc",
  MODEL_ID: "gpt-4.1",
};

const ORG_MODEL_ID = "model_org_default";
const OVERRIDE_MODEL_ID = "model_project_override";

function fakeDeps(options: {
  projectSecrets?: Record<string, string>;
  projectOverrideModelId?: string | null;
  orgDefaultModelId?: string | null;
  models?: Record<string, { providerId: string; modelId: string }>;
  providerKeys?: Record<string, { apiKey: string; baseUrl: string }>;
}) {
  const models = options.models ?? {
    [ORG_MODEL_ID]: { providerId: "provider_org", modelId: "org-default-model" },
    [OVERRIDE_MODEL_ID]: { providerId: "provider_override", modelId: "override-model" },
  };
  const providerKeys = options.providerKeys ?? {
    provider_org: { apiKey: "org-key", baseUrl: "https://org.example/v1" },
    provider_override: { apiKey: "override-key", baseUrl: "https://override.example/v1" },
  };

  return {
    secrets: {
      decryptAllForProject: vi.fn(async () => ({ ...(options.projectSecrets ?? {}) })),
    },
    providers: {
      decryptApiKey: vi.fn(async (providerId: string) => providerKeys[providerId]?.apiKey ?? null),
      findById: vi.fn(async (_orgId: string, providerId: string) =>
        providerKeys[providerId]
          ? { id: providerId, baseUrl: providerKeys[providerId].baseUrl }
          : null,
      ),
    },
    models: {
      findById: vi.fn(async (_orgId: string, modelId: string) =>
        models[modelId] ? { id: modelId, ...models[modelId] } : null,
      ),
    },
    jobDefaults: {
      findForJobKind: vi.fn(async () =>
        options.orgDefaultModelId ? { modelId: options.orgDefaultModelId } : null,
      ),
    },
    projectOverrides: {
      findForJobKind: vi.fn(async () =>
        options.projectOverrideModelId ? { modelId: options.projectOverrideModelId } : null,
      ),
    },
  };
}

describe("extractModelConfigBundle", () => {
  it("returns the bundle when all three keys are present", () => {
    expect(extractModelConfigBundle(FULL_BUNDLE)).toEqual(FULL_BUNDLE);
  });

  it("returns null when any key is missing", () => {
    const { MODEL_ID: _omit, ...partial } = FULL_BUNDLE;
    expect(extractModelConfigBundle(partial)).toBeNull();
  });

  it("returns null for an empty map", () => {
    expect(extractModelConfigBundle({})).toBeNull();
  });
});

describe("resolveModelConfigForJob", () => {
  it("prefers the project's own custom triplet when complete", async () => {
    const projectBundle = { ...FULL_BUNDLE, MODEL_ID: "project-model" };
    const deps = fakeDeps({ projectSecrets: projectBundle, orgDefaultModelId: ORG_MODEL_ID });

    const resolved = await resolveModelConfigForJob(deps as never, "proj_1", "org_1", "feature_build");

    expect(resolved).toEqual(projectBundle);
  });

  it("treats a partial custom triplet as unresolvable, not a fallback trigger", async () => {
    const deps = fakeDeps({
      projectSecrets: { MODEL_API_KEY: "sk-partial" },
      orgDefaultModelId: ORG_MODEL_ID,
    });

    const resolved = await resolveModelConfigForJob(deps as never, "proj_1", "org_1", "feature_build");

    expect(resolved).toBeNull();
  });

  it("falls back to the project's catalog override when no custom triplet is set", async () => {
    const deps = fakeDeps({ projectOverrideModelId: OVERRIDE_MODEL_ID, orgDefaultModelId: ORG_MODEL_ID });

    const resolved = await resolveModelConfigForJob(deps as never, "proj_1", "org_1", "feature_build");

    expect(resolved).toEqual({
      MODEL_BASE_URL: "https://override.example/v1",
      MODEL_API_KEY: "override-key",
      MODEL_ID: "override-model",
    });
  });

  it("falls back to the org's per-job-kind default when neither project path is set", async () => {
    const deps = fakeDeps({ orgDefaultModelId: ORG_MODEL_ID });

    const resolved = await resolveModelConfigForJob(deps as never, "proj_1", "org_1", "feature_build");

    expect(resolved).toEqual({
      MODEL_BASE_URL: "https://org.example/v1",
      MODEL_API_KEY: "org-key",
      MODEL_ID: "org-default-model",
    });
  });

  it("returns null when nothing resolves", async () => {
    const deps = fakeDeps({});

    const resolved = await resolveModelConfigForJob(deps as never, "proj_1", "org_1", "feature_build");

    expect(resolved).toBeNull();
  });
});
