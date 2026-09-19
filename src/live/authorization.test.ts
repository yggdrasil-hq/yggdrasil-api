import { describe, expect, it, vi } from "vitest";
import {
  authorizeDesignSessionSubscription,
  authorizeSubscription,
  authorizeTestSubscription,
} from "./authorization.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const FEATURE_ID = "33333333-3333-4333-8333-333333333333";
/** Issue #90: a `tests` row id — the resource the `test:` scope names. */
const TEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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

const SESSION_ID = "88888888-8888-4888-8888-888888888888";
/** In the project, but not a design session — the second condition to satisfy. */
const NON_DESIGN_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/**
 * Builds the two repositories the design decision consults, with the same
 * "defaults model the allowed case" convention as `buildDeps` above.
 *
 * The job fake is keyed on the id rather than a boolean on purpose: the kind check
 * is only meaningful if a *resolvable* job of the wrong kind gets past the project
 * condition, and a fake that returned null for it would exercise the not-found
 * path instead — passing for the wrong reason.
 */
function buildDesignDeps(
  options: {
    project?: { id: string } | null;
    job?: { id: string; kind: string } | null;
  } = {},
) {
  const findByIdForUser = vi.fn(async () =>
    options.project === undefined ? { id: PROJECT_ID } : options.project,
  );
  const findByIdForProject = vi.fn(async (projectId: string, jobId: string) => {
    if (options.job !== undefined) return options.job;
    if (jobId === SESSION_ID) return { id: SESSION_ID, kind: "design_grill" };
    if (jobId === NON_DESIGN_JOB_ID) return { id: NON_DESIGN_JOB_ID, kind: "feature_build" };
    return null;
  });
  return {
    deps: {
      projects: { findByIdForUser } as never,
      jobs: { findByIdForProject } as never,
    },
    findByIdForUser,
    findByIdForProject,
  };
}

describe("authorizeDesignSessionSubscription (issue #25)", () => {
  it("allows a member of the project's organization to watch its design session", async () => {
    const { deps } = buildDesignDeps();
    const decision = await authorizeDesignSessionSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("resolves the session inside the authorised project, scoped to the user", async () => {
    const { deps, findByIdForUser, findByIdForProject } = buildDesignDeps();
    await authorizeDesignSessionSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });

    expect(findByIdForUser).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
    // The project's *resolved* id, not the request's — which is what makes a
    // project the caller cannot see unable to authorise anything.
    expect(findByIdForProject).toHaveBeenCalledWith(PROJECT_ID, SESSION_ID);
  });

  it("refuses a non-member without revealing whether the session exists", async () => {
    // The non-disclosure rule: a non-member and a missing session must be
    // indistinguishable, or the relay becomes an existence oracle (ADR 019 item 3).
    const { deps, findByIdForProject } = buildDesignDeps({ project: null });
    const decision = await authorizeDesignSessionSubscription(deps, {
      userId: USER_ID,
      projectId: OTHER_PROJECT_ID,
      sessionId: SESSION_ID,
    });

    expect(decision).toEqual({ ok: false, reason: "project" });
    // The session is never looked up on this path.
    expect(findByIdForProject).not.toHaveBeenCalled();
  });

  it("refuses a job in the project that is not a design session", async () => {
    // The check the REST route has and a bare id lookup would not: any job id
    // resolves through `findByIdForProject`, so without this a socket could
    // subscribe to a feature_build's or a deploy's events through the
    // design-session frame.
    const { deps } = buildDesignDeps();
    const decision = await authorizeDesignSessionSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      sessionId: NON_DESIGN_JOB_ID,
    });

    expect(decision).toEqual({ ok: false, reason: "session" });
  });

  it("refuses a session id that is not in the project", async () => {
    const { deps } = buildDesignDeps({ job: null });
    const decision = await authorizeDesignSessionSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });

    expect(decision).toEqual({ ok: false, reason: "session" });
  });

  it("refuses ids that are not uuids without touching the database", async () => {
    for (const request of [
      { projectId: "not-a-uuid", sessionId: SESSION_ID },
      { projectId: PROJECT_ID, sessionId: "not-a-uuid" },
    ]) {
      const { deps, findByIdForUser, findByIdForProject } = buildDesignDeps();
      const decision = await authorizeDesignSessionSubscription(deps, {
        userId: USER_ID,
        ...request,
      });

      expect(decision).toEqual({ ok: false, reason: "session" });
      expect(findByIdForUser).not.toHaveBeenCalled();
      expect(findByIdForProject).not.toHaveBeenCalled();
    }
  });

  it("does not require the job to carry a design id", async () => {
    // The REST route tests `kind !== 'design_grill'` and nothing else, so an extra
    // condition here would make the socket *stricter* than the read it signals —
    // ADR 019 item 7's own failure mode, where a legitimate page looks subscribed
    // while its events are refused and falls back to polling with no explanation.
    const { deps } = buildDesignDeps({
      job: { id: SESSION_ID, kind: "design_grill" },
    });
    const decision = await authorizeDesignSessionSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });

    expect(decision).toEqual({ ok: true });
  });
});

/**
 * Builds the two repositories the test decision consults: the project through
 * `findByIdForUser` (the org-membership join) and the test through
 * `tests.findById`, scoped by project. The same default shape as the other two,
 * so each test only has to describe what is wrong.
 */
function buildTestDeps(
  options: {
    /** null models a non-member (or a project that does not exist). */
    project?: { id: string } | null;
    /** null models a test id that is not in that project. */
    test?: { id: string } | null;
  } = {},
) {
  const findByIdForUser = vi.fn(async () =>
    options.project === undefined ? { id: PROJECT_ID } : options.project,
  );
  const findById = vi.fn(async () =>
    options.test === undefined ? { id: TEST_ID } : options.test,
  );
  return {
    deps: {
      projects: { findByIdForUser } as never,
      tests: { findById } as never,
    },
    findByIdForUser,
    findById,
  };
}

describe("authorizeTestSubscription (issue #90)", () => {
  it("allows a member of the project's organization to watch its test", async () => {
    const { deps } = buildTestDeps();
    const decision = await authorizeTestSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      testId: TEST_ID,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("resolves the test inside the authorised project, scoped to the user", async () => {
    // This ordering is the reason `test:<testId>` was chosen over `job:<jobId>`:
    // it mirrors `GET /projects/:projectId/tests/:testId/runs` one-to-one, so the
    // socket is neither stricter nor looser than the read it signals.
    const { deps, findByIdForUser, findById } = buildTestDeps();
    await authorizeTestSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      testId: TEST_ID,
    });

    expect(findByIdForUser).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
    // The project's *resolved* id, not the request's — which is what makes a
    // project the caller cannot see unable to authorise anything. `tests.findById`
    // scopes by project, so another organization's test id cannot resolve.
    expect(findById).toHaveBeenCalledWith(PROJECT_ID, TEST_ID);
  });

  it("refuses a non-member without revealing whether the test exists", async () => {
    const { deps, findById } = buildTestDeps({ project: null });
    const decision = await authorizeTestSubscription(deps, {
      userId: USER_ID,
      projectId: OTHER_PROJECT_ID,
      testId: TEST_ID,
    });

    expect(decision).toEqual({ ok: false, reason: "project" });
    // The test is never looked up on this path.
    expect(findById).not.toHaveBeenCalled();
  });

  it("refuses a test id that is not in the project", async () => {
    const { deps } = buildTestDeps({ test: null });
    const decision = await authorizeTestSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      testId: TEST_ID,
    });

    expect(decision).toEqual({ ok: false, reason: "test" });
  });

  it("refuses ids that are not uuids without touching the database", async () => {
    // The route parses its path parameter before any query, so a malformed id is
    // a 404 there rather than a Postgres invalid-uuid error. Same here.
    for (const request of [
      { projectId: "not-a-uuid", testId: TEST_ID },
      { projectId: PROJECT_ID, testId: "not-a-uuid" },
    ]) {
      const { deps, findByIdForUser, findById } = buildTestDeps();
      const decision = await authorizeTestSubscription(deps, {
        userId: USER_ID,
        ...request,
      });

      expect(decision).toEqual({ ok: false, reason: "test" });
      expect(findByIdForUser).not.toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
    }
  });

  it("re-authorises on every call rather than caching a decision", async () => {
    // The socket calls this once per `subscribe_test` frame. A cache here would
    // let a socket that unsubscribed and resubscribed keep access it had lost.
    const { deps, findByIdForUser } = buildTestDeps();
    await authorizeTestSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      testId: TEST_ID,
    });
    await authorizeTestSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      testId: TEST_ID,
    });

    expect(findByIdForUser).toHaveBeenCalledTimes(2);
  });
});
