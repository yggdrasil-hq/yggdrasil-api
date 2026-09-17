import { describe, expect, it, vi } from "vitest";
import {
  extractModelConfigBundle,
  resolveModelConfigForJob,
  resolveModelConfigForJobWithSource,
  resolveModelConfigSource,
} from "./model-config.js";

const FULL_BUNDLE = {
  MODEL_BASE_URL: "https://api.openai.com/v1",
  MODEL_API_KEY: "sk-abc",
  MODEL_ID: "gpt-4.1",
};

const ORG_MODEL_ID = "model_org_default";
const OVERRIDE_MODEL_ID = "model_project_override";
const FEATURE_MODEL_ID = "model_feature_override";

function fakeDeps(options: {
  projectSecrets?: Record<string, string>;
  featureSecrets?: Record<string, string>;
  projectOverrideModelId?: string | null;
  featureOverrideModelId?: string | null;
  orgDefaultModelId?: string | null;
  models?: Record<string, { providerId: string; modelId: string }>;
  providerKeys?: Record<string, { apiKey: string; baseUrl: string }>;
}) {
  const models = options.models ?? {
    [ORG_MODEL_ID]: { providerId: "provider_org", modelId: "org-default-model" },
    [OVERRIDE_MODEL_ID]: { providerId: "provider_override", modelId: "override-model" },
    [FEATURE_MODEL_ID]: { providerId: "provider_feature", modelId: "feature-override-model" },
  };
  const providerKeys = options.providerKeys ?? {
    provider_org: { apiKey: "org-key", baseUrl: "https://org.example/v1" },
    provider_override: { apiKey: "override-key", baseUrl: "https://override.example/v1" },
    provider_feature: { apiKey: "feature-key", baseUrl: "https://feature.example/v1" },
  };

  return {
    secrets: {
      decryptAllForProject: vi.fn(async () => ({ ...(options.projectSecrets ?? {}) })),
    },
    featureSecrets: {
      decryptAllForFeature: vi.fn(async () => ({ ...(options.featureSecrets ?? {}) })),
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
    featureOverrides: {
      findForJobKind: vi.fn(async () =>
        options.featureOverrideModelId ? { modelId: options.featureOverrideModelId } : null,
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

// ADR 018 amendment (issue #5): the feature tier is the narrowest one — any job
// that belongs to a feature resolves through it before the project and org tiers.
describe("resolveModelConfigForJob with a feature id", () => {
  it("prefers the feature's own custom triplet over every other tier", async () => {
    const featureBundle = { ...FULL_BUNDLE, MODEL_ID: "feature-custom-model" };
    const deps = fakeDeps({
      featureSecrets: featureBundle,
      featureOverrideModelId: FEATURE_MODEL_ID,
      projectSecrets: { ...FULL_BUNDLE, MODEL_ID: "project-custom-model" },
      projectOverrideModelId: OVERRIDE_MODEL_ID,
      orgDefaultModelId: ORG_MODEL_ID,
    });

    const resolved = await resolveModelConfigForJob(
      deps as never,
      "proj_1",
      "org_1",
      "feature_build",
      "feat_1",
    );

    expect(resolved).toEqual(featureBundle);
  });

  it("prefers the feature's catalog override over the project's custom triplet and below", async () => {
    const deps = fakeDeps({
      featureOverrideModelId: FEATURE_MODEL_ID,
      projectSecrets: { ...FULL_BUNDLE, MODEL_ID: "project-custom-model" },
      projectOverrideModelId: OVERRIDE_MODEL_ID,
      orgDefaultModelId: ORG_MODEL_ID,
    });

    const resolved = await resolveModelConfigForJob(
      deps as never,
      "proj_1",
      "org_1",
      "feature_build",
      "feat_1",
    );

    expect(resolved).toEqual({
      MODEL_BASE_URL: "https://feature.example/v1",
      MODEL_API_KEY: "feature-key",
      MODEL_ID: "feature-override-model",
    });
  });

  it("falls through to the project's custom triplet when the feature tier is empty", async () => {
    const projectBundle = { ...FULL_BUNDLE, MODEL_ID: "project-custom-model" };
    const deps = fakeDeps({
      projectSecrets: projectBundle,
      projectOverrideModelId: OVERRIDE_MODEL_ID,
      orgDefaultModelId: ORG_MODEL_ID,
    });

    const resolved = await resolveModelConfigForJob(
      deps as never,
      "proj_1",
      "org_1",
      "feature_build",
      "feat_1",
    );

    expect(resolved).toEqual(projectBundle);
  });

  it("falls all the way through to the org default when no feature or project value is set", async () => {
    const deps = fakeDeps({ orgDefaultModelId: ORG_MODEL_ID });

    const resolved = await resolveModelConfigForJob(
      deps as never,
      "proj_1",
      "org_1",
      "feature_build",
      "feat_1",
    );

    expect(resolved).toEqual({
      MODEL_BASE_URL: "https://org.example/v1",
      MODEL_API_KEY: "org-key",
      MODEL_ID: "org-default-model",
    });
  });

  it("ignores the feature tier entirely when no feature ids is given", async () => {
    const deps = fakeDeps({
      featureSecrets: { ...FULL_BUNDLE, MODEL_ID: "feature-custom-model" },
      featureOverrideModelId: FEATURE_MODEL_ID,
      orgDefaultModelId: ORG_MODEL_ID,
    });

    const resolved = await resolveModelConfigForJob(deps as never, "proj_1", "org_1", "feature_build");

    expect(resolved).toEqual({
      MODEL_BASE_URL: "https://org.example/v1",
      MODEL_API_KEY: "org-key",
      MODEL_ID: "org-default-model",
    });
    expect(deps.featureOverrides.findForJobKind).not.toHaveBeenCalled();
  });

  // All-or-nothing (ADR 007, kept by ADR 018 and its amendment): a partial
  // feature triplet is an inconsistent state, so it resolves to nothing rather
  // than silently falling through to a lower tier that would hide it.
  it("treats a partial feature triplet as unresolvable, not a fallback trigger", async () => {
    const deps = fakeDeps({
      featureSecrets: { MODEL_API_KEY: "sk-partial" },
      orgDefaultModelId: ORG_MODEL_ID,
      projectOverrideModelId: OVERRIDE_MODEL_ID,
    });

    const resolved = await resolveModelConfigForJob(
      deps as never,
      "proj_1",
      "org_1",
      "feature_build",
      "feat_1",
    );

    expect(resolved).toBeNull();
  });
});

describe("resolveModelConfigSource", () => {
  const input = {
    projectId: "proj_1",
    organizationId: "org_1",
    jobKind: "feature_build" as const,
    featureId: "feat_1",
  };

  it("names the feature custom triplet as the winning tier", async () => {
    const deps = fakeDeps({
      featureSecrets: FULL_BUNDLE,
      projectSecrets: FULL_BUNDLE,
      orgDefaultModelId: ORG_MODEL_ID,
    });

    await expect(resolveModelConfigSource(deps as never, input)).resolves.toEqual({
      source: "feature_custom",
      modelId: null,
    });
  });

  it("names the feature catalog override and its model id", async () => {
    const deps = fakeDeps({ featureOverrideModelId: FEATURE_MODEL_ID, orgDefaultModelId: ORG_MODEL_ID });

    await expect(resolveModelConfigSource(deps as never, input)).resolves.toEqual({
      source: "feature_override",
      modelId: FEATURE_MODEL_ID,
    });
  });

  it("names the project custom triplet when the feature tier is empty", async () => {
    const deps = fakeDeps({ projectSecrets: FULL_BUNDLE, orgDefaultModelId: ORG_MODEL_ID });

    await expect(resolveModelConfigSource(deps as never, input)).resolves.toEqual({
      source: "project_custom",
      modelId: null,
    });
  });

  it("names the project catalog override when neither feature path is set", async () => {
    const deps = fakeDeps({ projectOverrideModelId: OVERRIDE_MODEL_ID, orgDefaultModelId: ORG_MODEL_ID });

    await expect(resolveModelConfigSource(deps as never, input)).resolves.toEqual({
      source: "project_override",
      modelId: OVERRIDE_MODEL_ID,
    });
  });

  it("names the organization default as the last resort", async () => {
    const deps = fakeDeps({ orgDefaultModelId: ORG_MODEL_ID });

    await expect(resolveModelConfigSource(deps as never, input)).resolves.toEqual({
      source: "organization_default",
      modelId: ORG_MODEL_ID,
    });
  });

  it("reports none when nothing is configured anywhere", async () => {
    const deps = fakeDeps({});

    await expect(resolveModelConfigSource(deps as never, input)).resolves.toEqual({
      source: "none",
      modelId: null,
    });
  });

  it("never decrypts provider keys — it only reports the tier", async () => {
    const deps = fakeDeps({ orgDefaultModelId: ORG_MODEL_ID });

    await resolveModelConfigSource(deps as never, input);

    expect(deps.providers.decryptApiKey).not.toHaveBeenCalled();
  });
});

describe("resolveModelConfigForJobWithSource", () => {
  it("returns the winning tier alongside its resolved values", async () => {
    const deps = fakeDeps({ featureOverrideModelId: FEATURE_MODEL_ID, orgDefaultModelId: ORG_MODEL_ID });

    const resolution = await resolveModelConfigForJobWithSource(deps as never, {
      projectId: "proj_1",
      organizationId: "org_1",
      jobKind: "feature_build",
      featureId: "feat_1",
    });

    expect(resolution.source).toBe("feature_override");
    expect(resolution.modelId).toBe(FEATURE_MODEL_ID);
    expect(resolution.config).toEqual({
      MODEL_BASE_URL: "https://feature.example/v1",
      MODEL_API_KEY: "feature-key",
      MODEL_ID: "feature-override-model",
    });
  });

  it("returns a null config with source none when nothing resolves", async () => {
    const deps = fakeDeps({});

    const resolution = await resolveModelConfigForJobWithSource(deps as never, {
      projectId: "proj_1",
      organizationId: "org_1",
      jobKind: "feature_build",
      featureId: "feat_1",
    });

    expect(resolution).toEqual({ source: "none", modelId: null, config: null });
  });
});
