import { isUuid } from "../shared/uuid.js";
import type { FeatureRepository } from "../features/repository.js";
import type { ProjectRepository } from "../projects/repository.js";

/**
 * Why a subscription was refused. Kept as two values for logging only — the
 * client is told "not found" for both, because distinguishing them would leak
 * whether a project or feature the caller cannot see exists (ADR 019 item 3).
 */
export type SubscriptionRefusal = "project" | "feature";

export type SubscriptionDecision = { ok: true } | { ok: false; reason: SubscriptionRefusal };

export interface SubscriptionRequest {
  userId: string;
  projectId: string;
  featureId: string;
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
