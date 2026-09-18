import { describe, expect, it } from "vitest";
import { getFeatureBucket, toPublicProject, type Project } from "./types.js";

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

/*
 * Issue #31 part 1's *read* half.
 *
 * `PUT /:projectId/timezone` makes the setting writable; without a reader it is
 * a stored value nothing consumes, which is the "looks like a feature while doing
 * nothing" shape the issue's own analysis warns about — the same reason that
 * worker declined to land a write-only timezone in the first place.
 *
 * These pin `toPublicProject`'s promotion of it out of the internal `settings`
 * bag, including the case that matters for a *stored* value: something else wrote
 * a non-string, and a client must get the default rather than a bogus zone.
 */
describe("toPublicProject — timeZone (issue #31 part 1)", () => {
  function project(settings: Record<string, unknown>): Project {
    return {
      id: "11111111-1111-4111-8111-111111111111",
      organizationId: "org_1",
      ownerUserId: "user_1",
      name: "P",
      slug: "p",
      description: "",
      status: "ready",
      settings,
      installationId: null,
      githubAccessWarning: false,
      modelConfigWarning: false,
      agenticReviewEnabled: true,
      uploadedExtensionsEnabled: false,
      hasDesignSurface: true,
      repositories: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Project;
  }

  it("exposes a stored zone", () => {
    expect(toPublicProject(project({ timezone: "America/New_York" })).timeZone).toBe(
      "America/New_York",
    );
  });

  it("reports null when the project has not set one", () => {
    expect(toPublicProject(project({})).timeZone).toBeNull();
    expect(toPublicProject(project({ other: "kept" })).timeZone).toBeNull();
  });

  it("does not leak the settings bag itself", () => {
    // A client reading `settings` directly would be coupled to a storage
    // decision, and every future preference would silently widen the contract.
    expect(toPublicProject(project({ timezone: "UTC" }))).not.toHaveProperty("settings");
  });

  it("degrades a non-string stored value to the default", () => {
    // Read-tolerant, matching the scheduler: a bad stored value must not reach a
    // client as a zone it will try to render.
    for (const bad of [42, null, { zone: "UTC" }, ["UTC"], true]) {
      expect(toPublicProject(project({ timezone: bad })).timeZone, String(bad)).toBeNull();
    }
  });

  it("passes a stored zone through unchanged, without validating it", () => {
    // Validation is a *write* concern (the route rejects a typo). A reader that
    // silently rewrote an unresolvable zone to null would hide the bad row from
    // the operator who has to fix it.
    expect(toPublicProject(project({ timezone: "Not/AZone" })).timeZone).toBe("Not/AZone");
  });
});
