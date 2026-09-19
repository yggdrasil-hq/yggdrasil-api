import { isUuid } from "../shared/uuid.js";
import type { FeatureRepository } from "../features/repository.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";

/**
 * Why a subscription was refused. Kept as three values for logging only — the
 * client is told "not found" for all of them, because distinguishing them would
 * leak whether a project, feature or session the caller cannot see exists
 * (ADR 019 item 3).
 */
export type SubscriptionRefusal = "project" | "feature" | "session";

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
