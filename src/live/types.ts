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
 * Issue #24: the connection exceeded its frame budget and was closed.
 *
 * A distinct code rather than reusing `LIVE_CLOSE_PROTOCOL`, which is documented
 * above as "a protocol mismatch". A rate limit is not a mismatch — the client did
 * nothing malformed — and collapsing the two would make a log line or a close
 * code unable to say which happened.
 *
 * **The client's correct response is to stop and fall back to polling**, exactly
 * as for the other two codes, and this is a cross-repo contract worth being
 * precise about: `web/lib/features/live-relay.ts` recognises 4401 and 4400 as
 * do-not-retry and treats *any other* code as retryable. Until the Web app learns
 * 4429, the interim behaviour is its bounded reconnect (ten attempts, 1s→30s
 * backoff, then it stays on the poll) — degraded but correct, because it always
 * ends in the complete REST state path and can never loop. Filed as a Web
 * follow-up; this comment is the contract a future reader needs to see.
 */
export const LIVE_CLOSE_RATE_LIMITED = 4429;

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

/**
 * The relay's subscription topic for a design session (issue #25).
 *
 * The sibling of `liveTopicForFeature` the comment above anticipated, and it is a
 * second *shape* rather than a second mechanism: the hub takes an opaque string,
 * so `design:` joining `feature:` is the whole change to the topic vocabulary.
 *
 * **The id is a job id.** A design session is a `design_grill` job (ADR 014), and
 * `GET /projects/:projectId/designs/:sessionId/events` resolves its `:sessionId` as
 * a job id — so this takes the same value a client already has from that REST read,
 * and no new identifier has to be threaded anywhere.
 */
export function liveTopicForDesignSession(sessionId: string): string {
  return `design:${sessionId}`;
}

/**
 * `pg_notify`'s hard limit is 8000 bytes. A streaming chunk is a handful of
 * bytes, so this is not a real constraint on deltas — it is a guard so that a
 * pathological value (a bug upstream, or a non-streaming producer misusing the
 * endpoint) is dropped with a log line instead of failing the notification and
 * taking the whole delta path down with it.
 */
export const LIVE_DELTA_MAX_PAYLOAD_BYTES = 7_000;

/**
 * Placeholder ids used only to *measure* a payload, never to send one.
 *
 * Real uuids, so their length and JSON shape are exactly what a real payload
 * carries — and therefore the measured size is exact rather than approximate.
 * Deliberately not a fixed "envelope overhead" constant: the first version of
 * this fix used one (109 bytes, measured with real uuids) and it was **wrong**,
 * because `JSON.stringify` escapes some characters. Text of 6891 newlines
 * serialises to a 13891-byte payload, not 7000 — so a constant envelope left a
 * gap twice as wide as the one being fixed, and in the same direction (route
 * accepts, publisher drops).
 */
const DELTA_PAYLOAD_PLACEHOLDER_FEATURE_ID = "00000000-0000-4000-8000-000000000000";
const DELTA_PAYLOAD_PLACEHOLDER_JOB_ID = "00000000-0000-4000-8000-000000000000";

/**
 * The exact serialised payload size a given text would produce (issue #78).
 *
 * Exported so the ingest route can bound the *real* thing rather than a proxy for
 * it. The route cannot use the real ids — it does not know the feature id until
 * after it has looked the job up, and it must decide before doing any work — but
 * it does not need them: uuids are fixed-width, so substituting same-shaped
 * placeholders gives a byte-identical envelope for any text.
 *
 * This is deliberately the same `JSON.stringify` the publisher performs, with the
 * same field order, so the two cannot disagree. Anything that changed the payload
 * shape (a new field, a reordering) would change both callers at once because
 * both go through this function.
 */
export function deltaPayloadBytes(text: string): number {
  return Buffer.byteLength(
    JSON.stringify({
      featureId: DELTA_PAYLOAD_PLACEHOLDER_FEATURE_ID,
      jobId: DELTA_PAYLOAD_PLACEHOLDER_JOB_ID,
      text,
    }),
  );
}

/**
 * Whether a delta text can actually be relayed (issue #78).
 *
 * The predicate the ingest route applies, so that "the route accepted it" and
 * "the publisher will send it" are the same statement. Before this they were
 * different statements expressed in different units, and non-ASCII text fell in
 * between.
 */
export function deltaTextFitsPayload(text: string): boolean {
  return deltaPayloadBytes(text) <= LIVE_DELTA_MAX_PAYLOAD_BYTES;
}



/** The JSON shape `LIVE_JOB_EVENT_DELTAS_CHANNEL`'s payload carries. */
export interface LiveDeltaPayload {
  featureId: string;
  jobId: string;
  text: string;
}

/**
 * Serialises a delta for `pg_notify`, or null when it cannot be sent.
 *
 * Pure and separate from the publisher so the payload contract (what the writer
 * emits and what `deltaFromPayload` reads) is testable on both sides without a
 * database — the same reason `relayEnvelopeFor` exists for stored events.
 */
export function encodeDeltaPayload(delta: LiveDeltaPayload): string | null {
  if (delta.text === "" || delta.featureId === "" || delta.jobId === "") return null;
  const payload = JSON.stringify(delta);
  // Measured in bytes, not characters: the 8000-byte NOTIFY limit counts the
  // encoded bytes, and a multi-byte character costs more than one.
  if (Buffer.byteLength(payload) > LIVE_DELTA_MAX_PAYLOAD_BYTES) return null;
  return payload;
}

/**
 * Parses a delta notification back into the frame its feature's subscribers
 * should receive, or null for anything malformed.
 *
 * Unlike the stored-event path this needs no database read, because the payload
 * is self-contained (the row it would have read does not exist). Null is the
 * whole error story: a delta is ephemeral, so a malformed one is dropped rather
 * than being allowed to disturb the listener.
 */
export function deltaFromPayload(
  payload: string,
): { topic: string; frame: ServerFrame } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const delta = parsed as Record<string, unknown>;
  if (typeof delta.featureId !== "string" || delta.featureId === "") return null;
  if (typeof delta.jobId !== "string" || delta.jobId === "") return null;
  if (typeof delta.text !== "string" || delta.text === "") return null;

  return {
    topic: liveTopicForFeature(delta.featureId),
    frame: {
      type: "job_event_delta",
      featureId: delta.featureId,
      jobId: delta.jobId,
      text: delta.text,
    },
  };
}

export type ServerFrame =
  | { type: "ready"; protocolVersion: number }
  | { type: "subscribed"; featureId: string }
  | { type: "unsubscribed"; featureId: string }
  /** Issue #25: the design-session peer of `subscribed`, naming a session rather than a feature. */
  | { type: "subscribed_design"; sessionId: string }
  | { type: "unsubscribed_design"; sessionId: string }
  | { type: "job_event"; featureId: string; jobId: string; event: LiveJobEvent }
  /**
   * Issue #25: a stored event for a design session.
   *
   * Its own type rather than a `job_event` carrying a session id in `featureId`,
   * so the frame says which topic shape it arrived on. `sessionId` is also the job
   * id — that is how the REST route resolves a session — so it is carried once and
   * the event's own `jobId` is the same value.
   */
  | { type: "design_session_event"; sessionId: string; event: LiveJobEvent }
  | { type: "job_event_delta"; featureId: string; jobId: string; text: string }
  | { type: "error"; message: string }
  | { type: "pong" };

/**
 * The Postgres channels the relay listens on.
 *
 * They live here, next to the frame vocabulary, because both are part of the
 * same cross-process contract and the writer and the listener must agree on the
 * exact spelling — a mismatch produces a relay that is silently never woken.
 * A test pins the repository's `pg_notify` against `LIVE_JOB_EVENTS_CHANNEL`
 * for exactly that reason.
 */

/**
 * Payload: one event id. The listener reads the row back, because NOTIFY caps
 * its payload at 8000 bytes and a stored event legitimately carries large
 * markdown, summaries and design snapshots.
 */
export const LIVE_JOB_EVENTS_CHANNEL = "job_events";

/**
 * Payload: JSON `{featureId, jobId, text}` — self-contained, because a delta is
 * never stored and therefore cannot be read back. This is also why a delta must
 * not go directly to a single process's in-memory hub: every API replica's
 * listener has to see it so that sockets held by *any* replica receive it
 * (ADR 019 item 6; with the 2-replica deployment ADR 003 §20 commits to, an
 * in-process-only publish reaches roughly half of them).
 */
export const LIVE_JOB_EVENT_DELTAS_CHANNEL = "job_event_deltas";

export type ClientFrame =
  | { type: "subscribe"; projectId: string; featureId: string }
  | { type: "unsubscribe"; featureId: string }
  /**
   * Issue #25: subscribe to a design session instead of a feature.
   *
   * A distinct frame type rather than an optional field on `subscribe`, and the
   * reason is that the two carry a *different* resource with a *different*
   * authorisation rule — a feature is resolved inside its project, a design
   * session is a job resolved inside its project and then checked for kind. One
   * frame with both fields would need a precedence rule ("featureId wins if
   * present"), and a silent precedence rule in an authorisation path is exactly
   * the kind of thing that is read wrong. Naming the two frames separately makes
   * the parse unambiguous and each frame's authoriser the obvious one.
   *
   * `sessionId` matches the REST path parameter the client already holds
   * (`/projects/:projectId/designs/:sessionId/events`).
   */
  | { type: "subscribe_design"; projectId: string; sessionId: string }
  | { type: "unsubscribe_design"; sessionId: string }
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
  if (frame.type === "subscribe_design") {
    if (!isUuidValue(frame.projectId) || !isUuidValue(frame.sessionId)) return null;
    return { type: "subscribe_design", projectId: frame.projectId, sessionId: frame.sessionId };
  }
  if (frame.type === "unsubscribe_design") {
    if (!isUuidValue(frame.sessionId)) return null;
    return { type: "unsubscribe_design", sessionId: frame.sessionId };
  }
  return null;
}
