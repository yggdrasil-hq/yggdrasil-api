import { describe, expect, it } from "vitest";
import { toPublicFeature, type Feature } from "./types.js";

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: "feat_1",
    projectId: "proj_1",
    title: "Add dark mode",
    slug: "add-dark-mode",
    featureType: "normal",
    status: "draft",
    adrMarkdown: null,
    awaitingUserInput: false,
    adrApproved: false,
    branchName: null,
    prUrl: null,
    parentFeatureId: null,
    returnReason: null,
    returnComment: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("toPublicFeature specExcerpt", () => {
  it("falls back to a placeholder when there is no ADR yet", () => {
    const feature = toPublicFeature(makeFeature({ adrMarkdown: null }));
    expect(feature.specExcerpt).toBe("Spec in progress…");
  });

  it("strips bullet markers and bold syntax from the first content line", () => {
    const feature = toPublicFeature(
      makeFeature({
        adrMarkdown: "# ADR 001 — Project Init\n\n- **Status:** Proposed (project_init)\n",
      }),
    );
    expect(feature.specExcerpt).toBe("Status: Proposed (project_init)");
  });

  it("strips inline code and italics", () => {
    const feature = toPublicFeature(
      makeFeature({ adrMarkdown: "Run `npm test` before *merging*." }),
    );
    expect(feature.specExcerpt).toBe("Run npm test before merging.");
  });

  it("falls back to the title when only header lines are present", () => {
    const feature = toPublicFeature(
      makeFeature({ title: "Add dark mode", adrMarkdown: "# ADR 001 — Add dark mode\n" }),
    );
    expect(feature.specExcerpt).toBe("Add dark mode");
  });
});
