import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "./slug.js";

describe("slugify", () => {
  it("normalizes titles into url-safe slugs", () => {
    expect(slugify("OAuth login with GitHub")).toBe("oauth-login-with-github");
  });
});

describe("uniqueSlug", () => {
  it("appends a suffix when the base slug is taken", async () => {
    const taken = new Set(["oauth-login"]);
    const slug = await uniqueSlug("OAuth login", async (candidate) => taken.has(candidate));
    expect(slug).toBe("oauth-login-2");
  });
});
