import { describe, expect, it } from "vitest";
import { isUuid } from "./uuid.js";

describe("isUuid", () => {
  it("accepts valid UUIDs", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("rejects mock string ids", () => {
    expect(isUuid("proj_acme")).toBe(false);
  });
});
