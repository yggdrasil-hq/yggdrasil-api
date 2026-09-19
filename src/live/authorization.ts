import { isUuid } from "../shared/uuid.js";
import type { FeatureRepository } from "../features/repository.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { TestRepository } from "../tests/repository.js";

/**
 * Why a subscription was refused. Kept as four values for logging only — the
 * client is told "not found" for all of them, because distinguishing them would
 * leak whether a project, feature, session or test the caller cannot see exists
 * (ADR 019 item 3).
 */
export type SubscriptionRefusal = "project" | "feature" | "session" | "test";

export type SubscriptionDecision = { ok: true } | { ok: false; reason: SubscriptionRefusal };

export interface SubscriptionRequest {
  userId: string;
  projectId: string;
  featureId: string;
}

/** Issue #25: the design-session peer of `SubscriptionRequest`. */
export interface DesignSessionSubscriptionRequest {
  userId: string;
  projectId: string;
  /**
   * The session id, which **is** a job id — see
   * `GET /projects/:projectId/designs/:sessionId/events`. Named `sessionId` to
   * match that route's parameter, not because it is a different kind of value.
   */
  sessionId: string;
}

/** Issue #90: the Test-entity peer of `SubscriptionRequest`. */
export interface TestSubscriptionRequest {
  userId: string;
  projectId: string;
  /**
   * The `tests` row id, matching `GET /projects/:projectId/tests/:testId/runs`.
   * Not a job id — unlike the design-session case this is the resource's own id.
   */
  testId: string;
}

/**
 * Decides whether a socket may receive a feature's events.
 *
 * This mirrors `GET /projects/:projectId/features/:featureId/events` exactly,
 * which is the point: the relay replaces that read's *latency*, so it must not
 * widen its *access*. The REST route resolves the project through
 * `getOwnedProject` — `projects.findByIdForUser`, which joins
 * `organization_memberships` (ADR 016) and so yields a project only for a
 * member of its organization — and then resolves the feature *within* that
 * project. Both are reproduced here in the same order, and both failing cases
 * collapse to one refusal, exactly as both are a 404 there.
 *
 * Consequence worth stating: resolving the feature inside the project is what
 * makes another organization's feature id a refusal rather than a leak. A
 * single `features.findById(featureId)` with no project scope would have
 * authorised any feature to any authenticated user.
 *
 * Re-checked on every `subscribe` frame, never cached across frames: a socket
 * that unsubscribes and resubscribes re-authorises. What is *not* re-checked is
 * an existing subscription when membership is revoked mid-socket — see ADR 019
 * item 10 for that bound and why it is accepted.
 */
export async function authorizeSubscription(
  deps: { projects: ProjectRepository; features: FeatureRepository },
  request: SubscriptionRequest,
): Promise<SubscriptionDecision> {
  if (!isUuid(request.projectId) || !isUuid(request.featureId)) {
    return { ok: false, reason: "feature" };
  }

  const project = await deps.projects.findByIdForUser(request.projectId, request.userId);
  if (!project) {
    return { ok: false, reason: "project" };
  }

  const feature = await deps.features.findById(project.id, request.featureId);
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
 * Re-checked on every `subscribe_design` frame, never cached — the same rule the
 * feature path follows. Both refusals collapse to one client message, as both are
 * a 404 there.
 */
export async function authorizeDesignSessionSubscription(
  deps: { projects: ProjectRepository; jobs: Pick<JobRepository, "findByIdForProject"> },
  request: DesignSessionSubscriptionRequest,
): Promise<SubscriptionDecision> {
  if (!isUuid(request.projectId) || !isUuid(request.sessionId)) {
    return { ok: false, reason: "session" };
  }

  const project = await deps.projects.findByIdForUser(request.projectId, request.userId);
  if (!project) {
    return { ok: false, reason: "project" };
  }

  const job = await deps.jobs.findByIdForProject(project.id, request.sessionId);
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
 *   both existing topics.
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
 * Re-checked on every `subscribe_test` frame, never cached across frames: a
 * socket that unsubscribes and resubscribes re-authorises, the same rule both
 * other paths follow. Both refusals collapse to one client message, as both are
 * a 404 there.
 */
export async function authorizeTestSubscription(
  deps: { projects: ProjectRepository; tests: Pick<TestRepository, "findById"> },
  request: TestSubscriptionRequest,
): Promise<SubscriptionDecision> {
  if (!isUuid(request.projectId) || !isUuid(request.testId)) {
    return { ok: false, reason: "test" };
  }

  const project = await deps.projects.findByIdForUser(request.projectId, request.userId);
  if (!project) {
    return { ok: false, reason: "project" };
  }

  const test = await deps.tests.findById(project.id, request.testId);
  if (!test) {
    return { ok: false, reason: "test" };
  }

  return { ok: true };
}
