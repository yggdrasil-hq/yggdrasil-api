import { describe, expect, it, vi } from "vitest";
import { extractModelConfigBundle, resolveModelConfig } from "./model-config.js";

function fakeDeps(projectSecrets: Record<string, string>, orgSecrets: Record<string, string>) {
  return {
    secrets: {
      decryptAllForProject: vi.fn(async () => ({ ...projectSecrets })),
    },
    orgSecrets: {
      decryptAllForOrganization: vi.fn(async () => ({ ...orgSecrets })),
    },
  };
}

const FULL_BUNDLE = {
  MODEL_BASE_URL: "https://api.openai.com/v1",
  MODEL_API_KEY: "sk-abc",
  MODEL_ID: "gpt-4.1",
};

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

describe("resolveModelConfig", () => {
  it("prefers the project's own bundle when complete", async () => {
    const projectBundle = { ...FULL_BUNDLE, MODEL_ID: "project-model" };
    const deps = fakeDeps(projectBundle, FULL_BUNDLE);

    const resolved = await resolveModelConfig(deps as never, "proj_1", "org_1");

    expect(resolved).toEqual(projectBundle);
  });

  it("falls back to the org's config when the project has none set (ADR 016 item 9)", async () => {
    const deps = fakeDeps({}, FULL_BUNDLE);

    const resolved = await resolveModelConfig(deps as never, "proj_1", "org_1");

    expect(resolved).toEqual(FULL_BUNDLE);
  });

  it("treats a partial project override as unresolvable, not a fallback trigger", async () => {
    const deps = fakeDeps({ MODEL_API_KEY: "sk-partial" }, FULL_BUNDLE);

    const resolved = await resolveModelConfig(deps as never, "proj_1", "org_1");

    expect(resolved).toBeNull();
  });

  it("returns null when neither the project nor the org config resolves", async () => {
    const deps = fakeDeps({}, {});

    const resolved = await resolveModelConfig(deps as never, "proj_1", "org_1");

    expect(resolved).toBeNull();
  });
});