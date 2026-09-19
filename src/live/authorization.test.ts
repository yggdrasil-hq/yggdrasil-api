import { describe, expect, it, vi } from "vitest";
import { SCOPE_AUTHORIZERS, authorizeScopeSubscription } from "./authorization.js";
import { LIVE_SCOPE_KINDS, type LiveScope } from "./types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const FEATURE_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "88888888-8888-4888-8888-888888888888";
/** In the project, but not a design session — the second condition to satisfy. */
const NON_DESIGN_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** Issue #90: a `tests` row id — the resource the `test:` scope names. */
const TEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/**
 * Builds the four repositories the authoriser registry consults. The defaults
 * model a member of the project's organization with everything resolvable — the
 * state every "allowed" case starts from — so each test only has to describe what
 * is wrong.
 *
 * **All four are provided even where a scope uses two**, because ADR 033 §2 has one
 * entry point with one dependency object; and the job fake is keyed on the id rather
 * than a boolean on purpose: the kind check is only meaningful if a *resolvable* job
 * of the wrong kind gets past the project condition, and a fake that returned null
 * for it would exercise the not-found path instead — passing for the wrong reason.
 */
function buildDeps(
  options: {
    /** null models a non-member (or a project that does not exist). */
    project?: { id: string } | null;
    feature?: { id: string } | null;
    test?: { id: string } | null;
    job?: { id: string; kind: string } | null;
  } = {},
) {
  const findByIdForUser = vi.fn(async () =>
    options.project === undefined ? { id: PROJECT_ID } : options.project,
  );
  const findById = vi.fn(async () =>
    options.test === undefined ? { id: TEST_ID } : options.test,
  );
  const featuresFindById = vi.fn(async () =>
    options.feature === undefined ? { id: FEATURE_ID } : options.feature,
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
      features: { findById: featuresFindById } as never,
      jobs: { findByIdForProject } as never,
      tests: { findById } as never,
    },
    findByIdForUser,
    findById,
    featuresFindById,
    findByIdForProject,
  };
}

const featureScope: LiveScope = { kind: "feature", id: FEATURE_ID };
const designScope: LiveScope = { kind: "design_session", id: SESSION_ID };
const testScope: LiveScope = { kind: "test", id: TEST_ID };

describe("SCOPE_AUTHORIZERS (ADR 033 §2)", () => {
  it("has one entry per kind in the closed union", () => {
    // Exhaustiveness is a *type* property — `Record<LiveScopeKind, …>` fails to
    // compile if a kind is added without an authoriser — but the runtime list is
    // what the wire validation uses, so the two are asserted to agree here. This is
    // the check that makes "a new scope costs a kind value, a topic builder and an
    // authoriser" something the build enforces rather than something a comment
    // promises.
    expect(Object.keys(SCOPE_AUTHORIZERS).sort()).toEqual([...LIVE_SCOPE_KINDS].sort());
    for (const kind of LIVE_SCOPE_KINDS) {
      expect(typeof SCOPE_AUTHORIZERS[kind].authorize).toBe("function");
    }
  });

  it("names the REST route each authoriser mirrors", () => {
    // ADR 019 item 7 requires the socket to be neither stricter nor looser than the
    // read it signals, and ADR 033 §2 requires each authoriser to *name* that read.
    // A field rather than only a comment so the pairing is assertable — see
    // `authorization-routes.test.ts`, which checks each path exists in the real
    // router.
    for (const kind of LIVE_SCOPE_KINDS) {
      expect(SCOPE_AUTHORIZERS[kind].mirrors).toMatch(/^\/projects\/:projectId\//);
    }
    expect(SCOPE_AUTHORIZERS.feature.mirrors).toBe(
      "/projects/:projectId/features/:featureId/events",
    );
    expect(SCOPE_AUTHORIZERS.design_session.mirrors).toBe(
      "/projects/:projectId/designs/:sessionId/events",
    );
    expect(SCOPE_AUTHORIZERS.test.mirrors).toBe("/projects/:projectId/tests/:testId/runs");
  });

  it("gives each kind a distinct route, so no two scopes share one gate", () => {
    const routes = LIVE_SCOPE_KINDS.map((kind) => SCOPE_AUTHORIZERS[kind].mirrors);
    expect(new Set(routes).size).toBe(LIVE_SCOPE_KINDS.length);
  });

  it("has a distinct refusal message per kind", () => {
    for (const kind of LIVE_SCOPE_KINDS) {
      expect(SCOPE_AUTHORIZERS[kind].refusalMessage.length).toBeGreaterThan(0);
    }
    const messages = LIVE_SCOPE_KINDS.map((kind) => SCOPE_AUTHORIZERS[kind].refusalMessage);
    expect(new Set(messages).size).toBe(LIVE_SCOPE_KINDS.length);
  });
});

describe("authorizeScopeSubscription, feature scope", () => {
  it("allows a member of the project's organization", async () => {
    const { deps } = buildDeps();
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: featureScope,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("refuses a non-member without revealing whether the project exists", async () => {
    // `findByIdForUser` is the same org-membership join the REST route uses, so
    // a non-member and a non-existent project are the same null — and must
    // produce the same refusal, or the relay becomes an existence oracle.
    const { deps, featuresFindById } = buildDeps({ project: null });
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: OTHER_PROJECT_ID,
      scope: featureScope,
    });

    expect(decision).toEqual({ ok: false, reason: "project" });
    // The feature is never even looked up on this path.
    expect(featuresFindById).not.toHaveBeenCalled();
  });

  it("refuses a feature that does not belong to the authorised project", async () => {
    // The case a bare `features.findById(featureId)` would have got wrong: it
    // would authorise any feature to any authenticated user.
    const { deps, featuresFindById } = buildDeps({ feature: null });
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: featureScope,
    });

    expect(decision).toEqual({ ok: false, reason: "feature" });
    // Scoped by project, exactly as the REST read resolves it.
    expect(featuresFindById).toHaveBeenCalledWith(PROJECT_ID, FEATURE_ID);
  });

  it("scopes the project lookup to the requesting user", async () => {
    const { deps, findByIdForUser } = buildDeps();
    await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: featureScope,
    });
    expect(findByIdForUser).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
  });

  it("refuses ids that are not uuids without touching the database", async () => {
    const { deps, findByIdForUser } = buildDeps();
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: "not-a-uuid",
      scope: featureScope,
    });
    expect(decision).toEqual({ ok: false, reason: "feature" });
    expect(findByIdForUser).not.toHaveBeenCalled();
  });

  it("does not resolve a test or a job for a feature subscription", async () => {
    // The per-kind separation, asserted rather than assumed: only the feature
    // branch runs, so a project-resolvable feature id cannot be satisfied by a
    // test or job lookup that happens to succeed.
    const { deps, findById, findByIdForProject } = buildDeps();
    await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: featureScope,
    });
    expect(findById).not.toHaveBeenCalled();
    expect(findByIdForProject).not.toHaveBeenCalled();
  });
});

describe("authorizeScopeSubscription, design_session scope (issue #25)", () => {
  it("allows a member of the project's organization to watch its design session", async () => {
    const { deps } = buildDeps();
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: designScope,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("resolves the session inside the authorised project, scoped to the user", async () => {
    const { deps, findByIdForUser, findByIdForProject } = buildDeps();
    await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: designScope,
    });

    expect(findByIdForUser).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
    // The project's *resolved* id, not the request's — which is what makes a
    // project the caller cannot see unable to authorise anything.
    expect(findByIdForProject).toHaveBeenCalledWith(PROJECT_ID, SESSION_ID);
  });

  it("refuses a non-member without revealing whether the session exists", async () => {
    // The non-disclosure rule: a non-member and a missing session must be
    // indistinguishable, or the relay becomes an existence oracle (ADR 019 item 3).
    const { deps, findByIdForProject } = buildDeps({ project: null });
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: OTHER_PROJECT_ID,
      scope: designScope,
    });

    expect(decision).toEqual({ ok: false, reason: "project" });
    // The session is never looked up on this path.
    expect(findByIdForProject).not.toHaveBeenCalled();
  });

  it("refuses a job in the project that is not a design session", async () => {
    // The check the REST route has and a bare id lookup would not: any job id
    // resolves through `findByIdForProject`, so without this a socket could
    // subscribe to a feature_build's or a deploy's events through a
    // design_session scope.
    const { deps } = buildDeps();
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: { kind: "design_session", id: NON_DESIGN_JOB_ID },
    });

    expect(decision).toEqual({ ok: false, reason: "session" });
  });

  it("refuses a session id that is not in the project", async () => {
    const { deps } = buildDeps({ job: null });
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: designScope,
    });

    expect(decision).toEqual({ ok: false, reason: "session" });
  });

  it("refuses ids that are not uuids without touching the database", async () => {
    for (const request of [
      { projectId: "not-a-uuid", scope: designScope },
      { projectId: PROJECT_ID, scope: { kind: "design_session" as const, id: "not-a-uuid" } },
    ]) {
      const { deps, findByIdForUser, findByIdForProject } = buildDeps();
      const decision = await authorizeScopeSubscription(deps, {
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
    const { deps } = buildDeps({ job: { id: SESSION_ID, kind: "design_grill" } });
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: designScope,
    });

    expect(decision).toEqual({ ok: true });
  });
});

describe("authorizeScopeSubscription, test scope (issue #90)", () => {
  it("allows a member of the project's organization to watch its test", async () => {
    const { deps } = buildDeps();
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: testScope,
    });
    expect(decision).toEqual({ ok: true });
  });

  it("resolves the test inside the authorised project, scoped to the user", async () => {
    // This ordering is the reason `test:<testId>` was chosen over `job:<jobId>`:
    // it mirrors `GET /projects/:projectId/tests/:testId/runs` one-to-one, so the
    // socket is neither stricter nor looser than the read it signals.
    const { deps, findByIdForUser, findById } = buildDeps();
    await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: testScope,
    });

    expect(findByIdForUser).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
    // The project's *resolved* id, not the request's — which is what makes a
    // project the caller cannot see unable to authorise anything. `tests.findById`
    // scopes by project, so another organization's test id cannot resolve.
    expect(findById).toHaveBeenCalledWith(PROJECT_ID, TEST_ID);
  });

  it("refuses a non-member without revealing whether the test exists", async () => {
    const { deps, findById } = buildDeps({ project: null });
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: OTHER_PROJECT_ID,
      scope: testScope,
    });

    expect(decision).toEqual({ ok: false, reason: "project" });
    // The test is never looked up on this path.
    expect(findById).not.toHaveBeenCalled();
  });

  it("refuses a test id that is not in the project", async () => {
    const { deps } = buildDeps({ test: null });
    const decision = await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: testScope,
    });

    expect(decision).toEqual({ ok: false, reason: "test" });
  });

  it("refuses ids that are not uuids without touching the database", async () => {
    // The route parses its path parameter before any query, so a malformed id is
    // a 404 there rather than a Postgres invalid-uuid error. Same here.
    for (const request of [
      { projectId: "not-a-uuid", scope: testScope },
      { projectId: PROJECT_ID, scope: { kind: "test" as const, id: "not-a-uuid" } },
    ]) {
      const { deps, findByIdForUser, findById } = buildDeps();
      const decision = await authorizeScopeSubscription(deps, {
        userId: USER_ID,
        ...request,
      });

      expect(decision).toEqual({ ok: false, reason: "test" });
      expect(findByIdForUser).not.toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
    }
  });

  it("re-authorises on every call rather than caching a decision", async () => {
    // The socket calls this once per subscribe frame. A cache here would let a
    // socket that unsubscribed and resubscribed keep access it had lost.
    const { deps, findByIdForUser } = buildDeps();
    await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: testScope,
    });
    await authorizeScopeSubscription(deps, {
      userId: USER_ID,
      projectId: PROJECT_ID,
      scope: testScope,
    });

    expect(findByIdForUser).toHaveBeenCalledTimes(2);
  });
});
