import { isUuid } from "../shared/uuid.js";
import type { FeatureRepository } from "../features/repository.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { TestRepository } from "../tests/repository.js";
import type { LiveScope, LiveScopeKind } from "./types.js";

/**
 * Why a subscription was refused. Kept as four values for logging only — the
 * client is told one message for all of them, because distinguishing them would
 * leak whether a project, feature, session or test the caller cannot see exists
 * (ADR 019 item 3).
 */
export type SubscriptionRefusal = "project" | "feature" | "session" | "test";

export type SubscriptionDecision = { ok: true } | { ok: false; reason: SubscriptionRefusal };

/**
 * One subscription request, for **any** scope (ADR 033 §1).
 *
 * Where version 1 had three request shapes and three entry points, this has one
 * carrying a tagged scope. The tag is a closed union, so the authorisation rule is
 * selected by `kind` in the registry below rather than by a precedence rule over
 * which fields happen to be present — which is the concern version 1's separate
 * frames were written to avoid, answered rather than overruled.
 */
export interface SubscriptionRequest {
  userId: string;
  /**
   * The project the caller must be a member of, and the project the scope is
   * resolved *inside*.
   *
   * Every authoriser below resolves its resource within this project, which is
   * the property that makes another organization's id a refusal rather than a
   * leak. It is also why the scope alone is not enough to authorise: a scope
   * carries a resource id and no project, deliberately, because the project is a
   * *separate* claim the caller must satisfy — `(scope)` alone would authorise any
   * resource to any authenticated user.
   */
  projectId: string;
  scope: LiveScope;
}

/**
 * What the socket's authorisers need. Every repository here is the one its REST
 * route uses, so a scope's socket gate cannot be satisfied by a read its route
 * would not have performed.
 */
export interface LiveAuthorizationDeps {
  projects: ProjectRepository;
  features: FeatureRepository;
  jobs: Pick<JobRepository, "findByIdForProject">;
  tests: Pick<TestRepository, "findById">;
}

/**
 * One registry entry: the authoriser, the REST route it mirrors, and the message a
 * refusal sends.
 *
 * **`mirrors` is a field and not only a comment.** ADR 033 §2 requires every
 * authoriser to *name the route it mirrors*, and ADR 019 item 7 requires the socket
 * to be neither stricter nor looser than that read. A field makes the pairing
 * checkable — `authorization.test.ts` asserts every entry names a `/projects/…`
 * route and that each path exists in the real router — where a comment can silently
 * go stale the day the route is renamed or narrowed.
 */
export interface ScopeAuthorizer {
  /** The REST route this scope's subscription mirrors. Asserted against the router. */
  mirrors: string;
  /** The client-facing refusal message. One per kind, for a log a human reads. */
  refusalMessage: string;
  authorize(
    deps: LiveAuthorizationDeps,
    request: SubscriptionRequest,
  ): Promise<SubscriptionDecision>;
}

/**
 * Decides whether a socket may receive a feature's events.
 *
 * Mirrors `GET /projects/:projectId/features/:featureId/events`, which is the
 * point: the relay replaces that read's *latency*, so it must not widen its
 * *access*. The REST route resolves the project through `getOwnedProject` —
 * `projects.findByIdForUser`, which joins `organization_memberships` (ADR 016) and
 * so yields a project only for a member of its organization — and then resolves the
 * feature *within* that project. Both are reproduced here in the same order, and
 * both failing cases collapse to one refusal, exactly as both are a 404 there.
 *
 * Consequence worth stating: resolving the feature inside the project is what makes
 * another organization's feature id a refusal rather than a leak. A single
 * `features.findById(featureId)` with no project scope would have authorised any
 * feature to any authenticated user.
 */
async function authorizeFeatureSubscription(
  deps: LiveAuthorizationDeps,
  request: SubscriptionRequest,
): Promise<SubscriptionDecision> {
  if (!isUuid(request.projectId) || !isUuid(request.scope.id)) {
    return { ok: false, reason: "feature" };
  }

  const project = await deps.projects.findByIdForUser(request.projectId, request.userId);
  if (!project) {
    return { ok: false, reason: "project" };
  }

  const feature = await deps.features.findById(project.id, request.scope.id);
  if (!feature) {
    return { ok: false, reason: "feature" };
  }

  return { ok: true };
}

/**
 * Decides whether a socket may receive a design session's events (issue #25).
 *
 * Mirrors `GET /projects/:projectId/designs/:sessionId/events` —
 * `projects/routes.ts` — in the same order and with the same two conditions:
 *
 * ```ts
 * const project = await getOwnedProject(req, req.params.projectId);   // findByIdForUser
 * const job = await deps.jobs.findByIdForProject(project.id, sessionId);
 * if (!job || job.kind !== "design_grill") 404
 * ```
 *
 * Three things about this are load-bearing rather than incidental:
 *
 * - **The project is resolved first, and the session inside it.** That ordering is
 *   what makes another organization's session id a refusal instead of a leak: the
 *   same reasoning as the feature case, and the reason both go through
 *   `findByIdForUser` (which joins `organization_memberships`, ADR 016) rather
 *   than a bare id lookup.
 * - **The kind is checked, not just the id.** `findByIdForProject` would happily
 *   resolve a `feature_build` or a `deploy` in the same project, and a socket
 *   subscribed to one of those would be receiving events for a job the design
 *   session page never asked about. The REST route has this check; so must this.
 * - **A job that is a `design_grill` but whose `design_id` is null is still
 *   allowed.** The route does not test `design_id`, so neither does this. An extra
 *   condition here would make the socket *stricter* than the read it signals,
 *   which ADR 019 item 7 calls out as its own failure: the page would look
 *   subscribed while its events were refused, and it would fall back to polling
 *   with nothing saying why.
 *
 * Re-checked on every `subscribe` frame for this scope, never cached — the same
 * rule the feature path follows. Both refusals collapse to one client message, as
 * both are a 404 there.
 *
 * **The scope's id is a job id**, which is the one place the tag is not optional:
 * `feature` and `test` scopes carry their resource's own id, while this carries the
 * job's. That is why `liveScopeForJob` keys this branch on the kind rather than on
 * the id's presence.
 */
async function authorizeDesignSessionSubscription(
  deps: LiveAuthorizationDeps,
  request: SubscriptionRequest,
): Promise<SubscriptionDecision> {
  if (!isUuid(request.projectId) || !isUuid(request.scope.id)) {
    return { ok: false, reason: "session" };
  }

  const project = await deps.projects.findByIdForUser(request.projectId, request.userId);
  if (!project) {
    return { ok: false, reason: "project" };
  }

  const job = await deps.jobs.findByIdForProject(project.id, request.scope.id);
  if (!job || job.kind !== "design_grill") {
    return { ok: false, reason: "session" };
  }

  return { ok: true };
}

/**
 * Decides whether a socket may receive a Test entity's run events (issue #90).
 *
 * Mirrors `GET /projects/:projectId/tests/:testId/runs` — `projects/routes.ts` —
 * in the same order and with the same two conditions:
 *
 * ```ts
 * const project = await getOwnedProject(req, req.params.projectId);   // findByIdForUser
 * const test = await deps.tests.findById(project.id, testId);
 * if (!test) 404
 * ```
 *
 * This is the whole reason `test:<testId>` was chosen over `job:<jobId>`: there
 * is a REST read to mirror, and mirroring it is a one-to-one translation. Two
 * properties follow, and both are required rather than incidental:
 *
 * - **The project is resolved first, and the test inside it.** `findByIdForUser`
 *   joins `organization_memberships` (ADR 016), and `tests.findById` scopes by
 *   `project_id`, so another organization's test id is a refusal and not a leak.
 *   This is the property `job:<jobId>` could not have offered: its natural check,
 *   `findByIdForProject`, binds a job to a project *only*, which is looser than
 *   both other scopes.
 * - **No kind or existence check beyond the test itself.** The route tests only
 *   that the test is in the project, so this does too. Adding "and the caller may
 *   see some run of it" would make the socket stricter than the read it signals,
 *   which ADR 019 item 7 calls out as its own failure: the page would look
 *   subscribed while its events were refused, with nothing saying why.
 *
 * `testId` is validated as a uuid before the first query, matching the route's
 * own parse of the path parameter — a malformed id is a refusal, not a query with
 * a value Postgres would reject as an invalid uuid literal.
 *
 * Re-checked on every `subscribe` frame for this scope, never cached across
 * frames: a socket that unsubscribes and resubscribes re-authorises, the same rule
 * both other paths follow. Both refusals collapse to one client message, as both
 * are a 404 there.
 */
async function authorizeTestSubscription(
  deps: LiveAuthorizationDeps,
  request: SubscriptionRequest,
): Promise<SubscriptionDecision> {
  if (!isUuid(request.projectId) || !isUuid(request.scope.id)) {
    return { ok: false, reason: "test" };
  }

  const project = await deps.projects.findByIdForUser(request.projectId, request.userId);
  if (!project) {
    return { ok: false, reason: "project" };
  }

  const test = await deps.tests.findById(project.id, request.scope.id);
  if (!test) {
    return { ok: false, reason: "test" };
  }

  return { ok: true };
}

/**
 * The authoriser registry, keyed by the closed union (ADR 033 §2).
 *
 * **`Record<LiveScopeKind, ScopeAuthorizer>` is the enforcement, not a lookup
 * convenience.** Adding a kind to `LiveScopeKind` without deciding who may
 * subscribe to it is a *compile* error, which is what turns "a new scope costs a
 * kind value, a topic builder and an authoriser" into something the build checks.
 * A `Map` keyed by string would compile and then fail at runtime as an
 * unsubscribable kind, or — worse, if a default were written — as a subscription
 * authorised by the wrong rule.
 *
 * **There is deliberately no shared `(projectId, resourceId)` helper.** That is the
 * shape ADR 033 §2 forbids, and the reason is ADR 019 item 7: each route above
 * resolves a *different* resource with a *different* rule (a feature inside the
 * project, a job inside the project *then* checked for kind, a test inside the
 * project), so a fusing of them could only be the loosest of the three. Three
 * entries that each name their route are the honest representation.
 */
export const SCOPE_AUTHORIZERS: Record<LiveScopeKind, ScopeAuthorizer> = {
  feature: {
    mirrors: "/projects/:projectId/features/:featureId/events",
    refusalMessage: "Feature not found",
    authorize: authorizeFeatureSubscription,
  },
  design_session: {
    mirrors: "/projects/:projectId/designs/:sessionId/events",
    refusalMessage: "Design session not found",
    authorize: authorizeDesignSessionSubscription,
  },
  test: {
    mirrors: "/projects/:projectId/tests/:testId/runs",
    refusalMessage: "Test not found",
    authorize: authorizeTestSubscription,
  },
};

/**
 * Decides whether a socket may receive a scope's events.
 *
 * The one entry point the socket calls. It selects by `kind` — a closed union, so
 * this cannot be handed a kind with no rule — and defers to that kind's authoriser,
 * which resolves its resource inside a project the caller is a member of.
 *
 * Re-checked on every subscribe frame, never cached across frames: a socket that
 * unsubscribes and resubscribes re-authorises. What is *not* re-checked is an
 * existing subscription when membership is revoked mid-socket — see ADR 019 item
 * 10 for that bound and why it is accepted.
 */
export async function authorizeScopeSubscription(
  deps: LiveAuthorizationDeps,
  request: SubscriptionRequest,
): Promise<SubscriptionDecision> {
  return SCOPE_AUTHORIZERS[request.scope.kind].authorize(deps, request);
}
