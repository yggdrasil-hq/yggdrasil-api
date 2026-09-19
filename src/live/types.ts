import { isUuid } from "../shared/uuid.js";
import type { JobEvent, JobEventActionItem } from "../jobs/events-repository.js";
import type { JobKind } from "../jobs/types.js";

/**
 * The wire protocol for the live job-event relay (ADR 019).
 *
 * The relay is a *change signal*, not a second source of truth: a frame says
 * "a job event was appended for this scope", and the Web app answers it by
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
 *
 * **Version 2 is ADR 033, and it replaced version 1 rather than sitting beside
 * it.** Version 1 named the scope in the frame (`job_event`,
 * `design_session_event`, `subscribe_design`, …), so every new scope cost a new
 * frame name and a second reader on both sides. Version 2 tags each frame with a
 * `scope` value instead, which is why `subscribed`, `event` and `delta` here
 * carry one and why there is no `job_event` any more.
 *
 * A version-1 client meeting this server sends `subscribe` with a `featureId` and
 * no `scope`, which `parseClientFrame` refuses; the server answers
 * `{type:"error"}`, and the Web client treats an `error` frame as terminal and
 * falls back to its poll (see `web/lib/features/live-relay.ts`). That degradation
 * is *proved by running*, not assumed — `scripts/verify-live-relay/verify.cjs`
 * drives a version-1 frame at this socket, because a mismatched-protocol path is
 * otherwise reached only during a bad upgrade window and would rot unexercised.
 */
export const LIVE_PROTOCOL_VERSION = 2;

/**
 * The kinds of thing a socket can subscribe to — **a closed union**, and the key
 * of both registries below (ADR 033 §2).
 *
 * Closed rather than a caller-supplied string is the whole safety property. The
 * thing a generalisation of this protocol must *not* become is a generic
 * `(projectId, resourceId)` subscription: that is a **looser** gate than any REST
 * route here, because each real route resolves its resource *inside* a project
 * the caller is a member of (ADR 019 item 7). Keying the registries by an enum
 * makes the looser shape unrepresentable — there is no branch that could accept
 * an unknown kind, and adding one requires adding an entry to every registry,
 * which is a visible edit rather than a silent widening.
 */
export type LiveScopeKind = "feature" | "design_session" | "test";

/**
 * The runtime list, and the one place the union is enumerated as a value.
 *
 * `Record<LiveScopeKind, …>` over the registry below is what makes the two
 * stay in step: a kind added to the type without a topic builder fails to
 * compile. This list exists for the *runtime* direction — validating an id from
 * the wire cannot be done by the type system.
 */
export const LIVE_SCOPE_KINDS = ["feature", "design_session", "test"] as const;

/**
 * One subscription: what kind of thing, and which one.
 *
 * **The tag travels with the id, which is the point of ADR 033 §1.** The framing
 * this replaces put a design session's job id into a field named `featureId` —
 * which the old code refused to do, at the cost of a second frame name and a
 * second reader on both sides. A reader that does not understand a kind now
 * rejects the frame instead of misreading the id, and there is no field whose
 * *name* claims a kind its contents might not have.
 */
export interface LiveScope {
  kind: LiveScopeKind;
  id: string;
}

export function isLiveScopeKind(value: unknown): value is LiveScopeKind {
  return (
    typeof value === "string" &&
    (LIVE_SCOPE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Validates a scope off the wire, returning null for anything unrecognised.
 *
 * An unknown `kind` is refused rather than ignored, deliberately: a client that
 * sends `job` (never a topic here) must not be answered with a subscription to
 * some other topic, and a frame the server cannot interpret is a protocol error
 * the client can act on. The id must be a uuid for the same reason the three
 * per-scope ids were validated at this boundary before — so an authoriser never
 * hands Postgres a string it will reject as an invalid uuid literal.
 */
export function parseLiveScope(value: unknown): LiveScope | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!isLiveScopeKind(candidate.kind)) return null;
  if (typeof candidate.id !== "string" || !isUuid(candidate.id)) return null;
  return { kind: candidate.kind, id: candidate.id };
}

/** Whether two scopes name the same subscription. */
export function scopesEqual(a: LiveScope, b: LiveScope): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/**
 * The relay's subscription topic for a scope — **the topic registry** (ADR 033
 * §2), replacing `liveTopicForFeature` / `liveTopicForDesignSession` /
 * `liveTopicForTest`.
 *
 * The hub treats a topic as an opaque string, so this is only the vocabulary that
 * keeps two scopes from colliding. Each prefix is namespaced and none is a bare
 * uuid, which is what makes that true.
 *
 * **Keyed by the closed union, so exhaustiveness is a compile error.** A `Record`
 * over `LiveScopeKind` means adding a kind without deciding its topic does not
 * build — which is the property that turns "a new scope is data" from a claim
 * into something the compiler enforces. The suffix is not always the kind's name:
 * `design_session`'s topic is `design:`, because that is the prefix issue #25
 * shipped and a topic is a cross-process contract (the API's listener and, via
 * the client, the page all agree on the string).
 *
 * **Two of the three ids are the resource; one is a job.** `feature:` takes a
 * feature id and `test:` takes a `tests` row id — both are routing keys that name
 * the surface. `design:` takes the *job* id, because a design session **is** a
 * `design_grill` job (ADR 014) and that is how
 * `GET /projects/:projectId/designs/:sessionId/events` resolves its
 * `:sessionId`, so it is the value a client already holds from that read. The
 * kind tag is what makes carrying two different kinds of id in one vocabulary
 * safe.
 */
const LIVE_TOPIC_BY_KIND: Record<LiveScopeKind, (id: string) => string> = {
  feature: (id) => `feature:${id}`,
  design_session: (id) => `design:${id}`,
  test: (id) => `test:${id}`,
};

export function liveTopicForScope(scope: LiveScope): string {
  return LIVE_TOPIC_BY_KIND[scope.kind](scope.id);
}

/**
 * The fields of a job row that decide which scope its events belong to.
 *
 * A structural input rather than `JobEventWithScope` or a `Job`, so that the
 * *stored-event* path and the *delta* path can both use one function. That is the
 * reason this exists at all: `relayEnvelopeFor` decides the topic of a stored
 * event and `publishDelta` decides the topic of a streaming chunk, and if the two
 * disagreed, half a message's text would reach a topic nobody is reading. One
 * function means they cannot.
 */
export interface JobScopeFields {
  /** The owning job's id. Needed because a design session's scope id *is* its job id. */
  jobId: string;
  featureId: string | null;
  jobKind: JobKind;
  testId: string | null;
}

/**
 * Which scope a job's events belong to, or null when nothing reads them.
 *
 * **Ordering is the contract, not an implementation detail.** Feature is checked
 * first and unconditionally, so a **feature-driven** `test_run` — one job with two
 * surfaces, carrying both a `feature_id` and a `test_id` — keeps routing to
 * `feature:` where it has always gone. The Test entity's page therefore gets no
 * socket signal for feature-driven runs, only for scheduled ones; that is a
 * pre-existing gap, filed as its own issue, and stated here because this is the
 * function where a reader would otherwise have to infer it.
 *
 * **Null is a real answer.** A job with no feature, not a design session and no
 * test — nothing produces one today — is dropped rather than guessed onto a topic,
 * because inventing a topic nobody reads would be noise pretending to be a signal.
 *
 * **The design branch is keyed on the kind, unlike the other two.** A feature id
 * and a test id each name a surface on their own, so the id's presence is the
 * whole test. A design session's id alone does not say what it is — it is a job id,
 * and a `feature_build` job id looks identical — so the kind is what makes it
 * interpretable. That asymmetry is why this function takes the kind at all.
 */
export function liveScopeForJob(job: JobScopeFields): LiveScope | null {
  if (job.featureId) return { kind: "feature", id: job.featureId };
  if (job.jobKind === "design_grill") return { kind: "design_session", id: job.jobId };
  if (job.testId) return { kind: "test", id: job.testId };
  return null;
}

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
const DELTA_PAYLOAD_PLACEHOLDER_SCOPE_ID = "00000000-0000-4000-8000-000000000000";
const DELTA_PAYLOAD_PLACEHOLDER_JOB_ID = "00000000-0000-4000-8000-000000000000";
/**
 * The kind the measurement uses. `feature` because it is the shortest of the
 * three (`design_session` is six bytes longer), so a payload measured with it is
 * the *smallest* such envelope — and the bound has to hold for every kind, not
 * the average one. Named rather than inlined so the reason is visible at the use
 * site: using a longer kind here would make the measured size exceed the real one
 * and refuse payloads that would have fitted.
 */
const DELTA_PAYLOAD_PLACEHOLDER_SCOPE_KIND: LiveScopeKind = "feature";

/**
 * The exact serialised payload size a given text would produce (issue #78).
 *
 * Exported so the ingest route can bound the *real* thing rather than a proxy for
 * it. The route cannot use the real ids — it does not know the scope id until
 * after it has looked the job up, and it must decide before doing any work — but
 * it does not need them: uuids are fixed-width, so substituting same-shaped
 * placeholders gives a byte-identical envelope for any text. The same holds for
 * the scope's `kind`, except there the placeholder is an explicit *choice*: the
 * shortest kind is used (see `DELTA_PAYLOAD_PLACEHOLDER_SCOPE_KIND`).
 *
 * This is deliberately the same `JSON.stringify` the publisher performs, with the
 * same field order, so the two cannot disagree. Anything that changed the payload
 * shape (a new field, a reordering) would change both callers at once because
 * both go through this function.
 */
export function deltaPayloadBytes(text: string): number {
  return Buffer.byteLength(
    JSON.stringify({
      scope: {
        kind: DELTA_PAYLOAD_PLACEHOLDER_SCOPE_KIND,
        id: DELTA_PAYLOAD_PLACEHOLDER_SCOPE_ID,
      },
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

/**
 * The JSON shape `LIVE_JOB_EVENT_DELTAS_CHANNEL`'s payload carries.
 *
 * `scope` rather than `featureId` (ADR 033 §5): the delta path was feature-scoped
 * end to end, which is why a design session's prose arrived per message instead of
 * per token (issue #95). Carrying the scope is the change that makes it a
 * first-class scope like any other — and it is the *only* change to this shape,
 * since a second payload shape was the alternative and is what ADR 033 rejects.
 */
export interface LiveDeltaPayload {
  scope: LiveScope;
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
  if (delta.text === "" || delta.jobId === "") return null;
  // Re-validated here rather than trusted from the caller: this function is the
  // last point before the payload becomes an unparseable box on the wire, and a
  // scope it cannot round-trip would be a delta delivered to no topic at all.
  if (delta.scope.id === "" || !isLiveScopeKind(delta.scope.kind)) return null;
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
  const scope = parseLiveScope(delta.scope);
  if (!scope) return null;
  if (typeof delta.jobId !== "string" || delta.jobId === "") return null;
  if (typeof delta.text !== "string" || delta.text === "") return null;

  return {
    topic: liveTopicForScope(scope),
    // `jobId` is deliberately **not** on the frame (ADR 033 §1's table). The
    // stored-event frame carries it because a reader matching a frame to a run
    // needs it; a delta is text to append, and the authoritative `agent_text`
    // that supersedes it carries the job. Keeping it in the payload is what
    // matters — that is where the ceiling is counted and where a log line about a
    // dropped delta finds its job.
    frame: { type: "delta", scope, text: delta.text },
  };
}

/**
 * The server's frame vocabulary (ADR 033 §1).
 *
 * Four frame names where version 1 had eleven: one subscribed/unsubscribed pair,
 * one event/delta pair, and the two that were never scope-specific (`ready`,
 * `error`, `pong`). Every scope-bearing frame carries a `scope`, so a reader knows
 * what an id means from the frame itself rather than from its `type`.
 *
 * The `event` frame is one shape for all scopes, which is a real trade-off and
 * worth stating: the per-scope frames existed partly to stop a feature reader
 * acting on a design event, and that protection now rests on the scope tag —
 * weaker at the *point of reading*, stronger at the point of writing, and enforced
 * by the tag being a closed union. The client re-checks the scope against the
 * subscription it made, so a mis-addressed frame is dropped rather than applied.
 */
export type ServerFrame =
  | { type: "ready"; protocolVersion: number }
  | { type: "subscribed"; scope: LiveScope }
  | { type: "unsubscribed"; scope: LiveScope }
  | { type: "event"; scope: LiveScope; event: LiveJobEvent }
  | { type: "delta"; scope: LiveScope; text: string }
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
 * Payload: JSON `{scope, jobId, text}` — self-contained, because a delta is
 * never stored and therefore cannot be read back. This is also why a delta must
 * not go directly to a single process's in-memory hub: every API replica's
 * listener has to see it so that sockets held by *any* replica receive it
 * (ADR 019 item 6; with the 2-replica deployment ADR 003 §20 commits to, an
 * in-process-only publish reaches roughly half of them).
 */
export const LIVE_JOB_EVENT_DELTAS_CHANNEL = "job_event_deltas";

export type ClientFrame =
  | { type: "subscribe"; projectId: string; scope: LiveScope }
  | { type: "unsubscribe"; scope: LiveScope }
  | { type: "ping" };

/**
 * The client's frame vocabulary (ADR 033 §1).
 *
 * Version 1 had six `subscribe`/`unsubscribe` frame names — two per scope — and the
 * comment on the design ones argued for the separate names on the ground that each
 * carried a different resource with a different authorisation rule, so folding them
 * together would need a precedence rule in an authorisation path. That reasoning
 * was sound about a *precedence rule* and is answered rather than overruled here:
 * a `scope` is not a precedence rule, it is a discriminant with a closed domain, and
 * the authorisation rule is selected by `kind` in its own registry (see
 * `authorization.ts`) rather than by which field happens to be present.
 */

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
    const scope = parseLiveScope(frame.scope);
    if (!isUuidValue(frame.projectId) || !scope) return null;
    return { type: "subscribe", projectId: frame.projectId, scope };
  }
  if (frame.type === "unsubscribe") {
    const scope = parseLiveScope(frame.scope);
    if (!scope) return null;
    return { type: "unsubscribe", scope };
  }
  return null;
}
