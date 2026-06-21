import { describe, expect, it } from "vitest";
import { getFeatureBucket } from "./types.js";

describe("getFeatureBucket", () => {
  it("maps ADR 002 lifecycle states to home page buckets", () => {
    expect(getFeatureBucket("draft")).toBe("planned");
    expect(getFeatureBucket("spec_ready")).toBe("planned");
    expect(getFeatureBucket("running")).toBe("inProgress");
    expect(getFeatureBucket("failed")).toBe("inProgress");
    expect(getFeatureBucket("merged")).toBe("completed");
    expect(getFeatureBucket("cancelled")).toBe("completed");
  });
});
