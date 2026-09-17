import { describe, expect, it, vi } from "vitest";
import { authorizeSubscription } from "./authorization.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const FEATURE_ID = "33333333-3333-4333-8333-333333333333";

/**
 * Builds the two repositories the decision consults. The defaults model a
 * member of the project's organization — the state every "allowed" case starts
 * from — so each test only has to describe what is wrong.
 */
function buildDeps(
  options: {
    /** null models a non-member (or a project that does not exist). */
    project?: { id: string } | null;
    /** null models a feature id that is not in that project. */
    feature?: { id: string } | null;
  } = {},
) {
  const findByIdForUser = vi.fn(async () =>
    options.project === undefined ? { id: PROJECT_ID } : options.project,
  );
  const findById = vi.fn(async () =>
    options.feature === undefined ? { id: FEATURE_ID } : options.feature,
  );
  return {
    deps: {
      projects: { findByIdForUser } as never,
      features: { findById } as never,
    },
    findByIdForUser,
    findById,
  };
}

describe("authorizeSubscription", () => {
  it("allows a member of the project's organization", async () => {
    const { deps } = buildDeps();
    const decision = await authorizeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      featureId: FEATURE_ID,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("refuses a non-member without revealing whether the project exists", async () => {
    // `findByIdForUser` is the same org-membership join the REST route uses, so
    // a non-member and a non-existent project are the same null — and must
    // produce the same refusal, or the relay becomes an existence oracle.
    const { deps, findById } = buildDeps({ project: null });
    const decision = await authorizeSubscription(deps, {
      userId: USER_ID,
      projectId: OTHER_PROJECT_ID,
      featureId: FEATURE_ID,
    });

    expect(decision).toEqual({ ok: false, reason: "project" });
    // The feature is never even looked up on this path.
    expect(findById).not.toHaveBeenCalled();
  });

  it("refuses a feature that does not belong to the authorised project", async () => {
    // The case a bare `features.findById(featureId)` would have got wrong: it
    // would authorise any feature to any authenticated user.
    const { deps, findById } = buildDeps({ feature: null });
    const decision = await authorizeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      featureId: FEATURE_ID,
    });

    expect(decision).toEqual({ ok: false, reason: "feature" });
    // Scoped by project, exactly as the REST read resolves it.
    expect(findById).toHaveBeenCalledWith(PROJECT_ID, FEATURE_ID);
  });

  it("scopes the project lookup to the requesting user", async () => {
    const { deps, findByIdForUser } = buildDeps();
    await authorizeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      featureId: FEATURE_ID,
    });
    expect(findByIdForUser).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
  });

  it("refuses ids that are not uuids without touching the database", async () => {
    const { deps, findByIdForUser } = buildDeps();
    const decision = await authorizeSubscription(deps, {
      userId: USER_ID,
      projectId: "not-a-uuid",
      featureId: FEATURE_ID,
    });
    expect(decision).toEqual({ ok: false, reason: "feature" });
    expect(findByIdForUser).not.toHaveBeenCalled();
  });
});
