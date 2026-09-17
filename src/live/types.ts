import { isUuid } from "../shared/uuid.js";
import type { JobEvent, JobEventActionItem } from "../jobs/events-repository.js";

/**
 * The wire protocol for the live job-event relay (ADR 019).
 *
 * The relay is a *change signal*, not a second source of truth: a frame says
 * "a job event was appended for this feature", and the Web app answers it by
 * re-reading the existing REST endpoint. That is deliberate — derived state
 * (`features.awaiting_user_input`, the feature's own status, `jobs.last_error`)
 * is computed server-side and is not in the event, so duplicating that
 * derivation in the browser would be a second implementation of the lifecycle
 * that could disagree with the API. Re-reading also makes the polling fallback
 * and the socket path share exactly one state path (ADR 019 item 7).
 */

/**
 * Bumped when a frame's shape changes incompatibly. Sent in the `ready` frame
 * so a client can tell an older API apart from a protocol it understands —
 * the relay is additive and optional, so a mismatch should degrade to polling
 * rather than throw.
 */
export const LIVE_PROTOCOL_VERSION = 1;

/**
 * Where the upgrade is served. A literal path, not a router mount: `ws`
 * answers the HTTP `upgrade` event directly, so this is outside Express
 * entirely (ADR 019 item 2). Externally this is `/api/ws`, because deploy's
 * nginx proxies `/api/` to this service's root.
 */
export const LIVE_SOCKET_PATH = "/ws";

/**
 * Application close codes (the 4000-4999 range is reserved for applications).
 * A client that sees one of these should stop retrying rather than loop: a
 * rejected credential is not going to become valid by reconnecting.
 */
export const LIVE_CLOSE_UNAUTHORIZED = 4401;
export const LIVE_CLOSE_PROTOCOL = 4400;

/**
 * A job event as it goes over the socket. `createdAt` is an ISO string here
 * for the same reason it is `Date` in the repository and a string in REST:
 * this is the wire shape, and it matches `GET .../events` exactly so the Web
 * app can reuse one `FeatureEvent` type for both (ADR 019 item 4).
 */
export interface LiveJobEvent {
  id: string;
  jobId: string;
  type: string;
  question: string | null;
  markdown: string | null;
  message: string | null;
  status: string | null;
  prUrl: string | null;
  summary: string | null;
  actionItems: JobEventActionItem[] | null;
  snapshot: Record<string, string> | null;
  createdAt: string;
}

/** Converts a stored event into its wire shape. */
export function toLiveJobEvent(event: JobEvent): LiveJobEvent {
  return {
    id: event.id,
    jobId: event.jobId,
    type: event.type,
    question: event.question,
    markdown: event.markdown,
    message: event.message,
    status: event.status,
    prUrl: event.prUrl,
    summary: event.summary,
    actionItems: event.actionItems,
    snapshot: event.snapshot,
    createdAt: event.createdAt.toISOString(),
  };
}

/**
 * The relay's subscription topic for a feature. Namespaced rather than a bare
 * feature id so a second topic shape (a design session, say) cannot collide
 * with it — the hub itself treats a topic as an opaque string.
 */
export function liveTopicForFeature(featureId: string): string {
  return `feature:${featureId}`;
}

export type ServerFrame =
  | { type: "ready"; protocolVersion: number }
  | { type: "subscribed"; featureId: string }
  | { type: "unsubscribed"; featureId: string }
  | { type: "job_event"; featureId: string; jobId: string; event: LiveJobEvent }
  | { type: "error"; message: string }
  | { type: "pong" };

export type ClientFrame =
  | { type: "subscribe"; projectId: string; featureId: string }
  | { type: "unsubscribe"; featureId: string }
  | { type: "ping" };

function isUuidValue(value: unknown): value is string {
  return typeof value === "string" && isUuid(value);
}

/**
 * Parses one client frame, returning null for anything malformed, unknown, or
 * with a non-uuid id. Returning null rather than throwing is what lets the
 * socket handler treat "a client sent nonsense" as a protocol error on that
 * connection instead of an unhandled rejection on the process (ADR 019 item 5).
 *
 * Ids are validated here, at the boundary, and the subscription is authorised
 * separately — a caller must not read a parsed frame as proof of access.
 */
export function parseClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const frame = parsed as Record<string, unknown>;
  if (frame.type === "ping") {
    return { type: "ping" };
  }
  if (frame.type === "subscribe") {
    if (!isUuidValue(frame.projectId) || !isUuidValue(frame.featureId)) return null;
    return { type: "subscribe", projectId: frame.projectId, featureId: frame.featureId };
  }
  if (frame.type === "unsubscribe") {
    if (!isUuidValue(frame.featureId)) return null;
    return { type: "unsubscribe", featureId: frame.featureId };
  }
  return null;
}
