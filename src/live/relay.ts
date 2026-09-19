import type { JobEventRepository, JobEventWithScope } from "../jobs/events-repository.js";
import type { LiveHub } from "./hub.js";
import {
  deltaFromPayload,
  LIVE_JOB_EVENT_DELTAS_CHANNEL,
  LIVE_JOB_EVENTS_CHANNEL,
  liveScopesForJob,
  liveTopicForScope,
  toLiveJobEvent,
  type ServerFrame,
} from "./types.js";

/**
 * Re-exported from `types.js`, where both channel names live together so the
 * writer and this listener cannot drift apart. Kept exported from here because
 * the repository test imports it from this module.
 */
export { LIVE_JOB_EVENTS_CHANNEL };

/**
 * The slice of `pg.Client` the relay uses. Narrow on purpose: a fake
 * implementation is then a dozen lines, which is what lets the reconnect and
 * routing rules be tested without a database (ADR 019 item 5).
 */
export interface LiveListenerClient {
  // `Promise<unknown>`, not `Promise<void>`: pg.Client's connect() resolves to
  // the client itself, and a narrower return type here would make a real client
  // structurally unassignable to this interface.
  connect(): Promise<unknown>;
  query(sql: string, values?: unknown[]): Promise<unknown>;
  // Method syntax (not a property) so this stays assignable from pg.Client's
  // own overloaded EventEmitter `on`.
  on(event: string, listener: (...args: any[]) => void): unknown;
  end(): Promise<void>;
}

export interface LiveRelayDeps {
  clientFactory: () => LiveListenerClient;
  hub: LiveHub;
  jobEvents: Pick<JobEventRepository, "findByIdWithScope">;
  onError?: (message: string) => void;
  /**
   * Injected so tests can drive reconnection deterministically. The default
   * uses the real timer.
   */
  scheduleRetry?: (run: () => void, delayMs: number) => unknown;
  cancelRetry?: (handle: unknown) => void;
  retryDelayMs?: number;
}

export interface LiveRelayHandle {
  /** Idempotent. Closes the listener and cancels any pending reconnect. */
  stop(): Promise<void>;
}

/**
 * Default reconnect delay. Fixed rather than backed off: the realistic failure
 * here is Postgres being unreachable for a while, which is not a burst that a
 * backoff would smooth out, and a flat 5s keeps the log readable and the
 * recovery prompt. The cost of a wrong guess is one failed query every 5s while
 * the database is down (ADR 019 item 8).
 */
export const LIVE_RELAY_RETRY_MS = 5000;

/**
 * Maps a loaded event to the frames its subscribers should receive — **one per
 * scope the job belongs to**, primary first.
 *
 * Split out as a pure function so "which event goes to which topic" — the only
 * routing decision in the relay — is testable without a socket, a database, or
 * a Postgres connection.
 *
 * **Plural since issue #100, and the plural is the fix.** A job can have two
 * surfaces: a feature-driven `test_run` carries a `feature_id` *and* a `test_id`,
 * and until this returned both, the Test entity's run history received no socket
 * signal for it — the Testing tab on the feature updated live while the Test's own
 * history sat still, for the same underlying run.
 *
 * **One envelope per scope, each carrying its own tag — not one envelope with two
 * scopes**, and the difference is not cosmetic:
 *
 *  - A frame naming two scopes is ambiguous at the one place it is read. The
 *    client's question is "is this event for the page I am rendering?", which with
 *    one tag is a comparison and with two is a puzzle. ADR 033 §1 made `scope` a
 *    closed union so a frame could not be misread; a two-scope frame hands the
 *    ambiguity straight back.
 *  - A subscriber to `test:<id>` was authorised for the test scope and nothing
 *    else, so a frame that also named the feature would hand that socket a claim
 *    its own authoriser never covered. One envelope per topic means each socket
 *    receives exactly what its gate allowed — ADR 019 item 7, ADR 033 §2.
 *  - The two deliveries stay independently droppable, which is what lets the
 *    per-topic budgets and the coalescing keep treating them separately.
 *
 * **Where the scope decision lives.** `liveScopesForJob` decides *which* scopes and
 * in what order — shared with the delta path, so a stored event and a streaming
 * chunk for one job cannot reach different topics, which would leave half a
 * message's text on a topic nobody is reading. This function's remaining job is to
 * turn each scope into a topic and a frame, and to drop an unscopable job.
 *
 * **What this replaced, and why the indirection is worth it.** Version 1 branched
 * here on the job's fields, picked one of three `liveTopicFor*` functions and built
 * one of three frame types. That meant each new scope edited this function, and the
 * frames it emitted were shaped so a reader could tell them apart *by type* — the
 * protection ADR 033 §1 moves into the scope tag. The scenario the branches
 * guarded, stated once so it is not re-derived: the two id spaces are both uuids
 * from the same source, so a router that confused them would deliver a feature's
 * events to a design session's subscribers with no error anywhere.
 */
export function relayEnvelopesFor(
  scope: JobEventWithScope,
): Array<{ topic: string; frame: ServerFrame }> {
  const scopes = liveScopesForJob({
    jobId: scope.event.jobId,
    featureId: scope.featureId,
    jobKind: scope.jobKind,
    testId: scope.testId,
  });
  if (scopes.length === 0) return [];

  // Built once and shared by every envelope: the event is the same record, and a
  // fan-out is not a reason to convert it twice. Each frame gets its own `scope`,
  // which is the one field that differs.
  const event = toLiveJobEvent(scope.event);
  return scopes.map((live) => ({
    topic: liveTopicForScope(live),
    frame: { type: "event", scope: live, event },
  }));
}

/**
 * Fans Postgres `job_events` notifications out to the sockets this process
 * holds (ADR 019 item 6).
 *
 * Why LISTEN/NOTIFY rather than a poll: the API already uses NOTIFY for the
 * reply and cancellation channels (ADR 006 items 9-10), and a timer poll would
 * reintroduce exactly the latency this lane exists to remove, just moved to the
 * server. Why not an in-process emitter on the write path: the events this
 * must relay are written by *any* API replica, and several replicas share the
 * database — an emitter would silently relay only the events the same process
 * happened to handle. Every replica runs one listener and reaches its own
 * sockets; the database is the bus between them.
 *
 * The connection is a dedicated client rather than a pooled one: LISTEN is
 * stateful per-connection, and a pooled connection may be recycled or reset
 * underneath it, silently dropping the subscription.
 */
export function startLiveRelay(deps: LiveRelayDeps): LiveRelayHandle {
  const retryDelayMs = deps.retryDelayMs ?? LIVE_RELAY_RETRY_MS;
  const scheduleRetry =
    deps.scheduleRetry ??
    ((run: () => void, delayMs: number) => setTimeout(run, delayMs));
  const cancelRetry =
    deps.cancelRetry ??
    ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const report = deps.onError ?? (() => {});

  let client: LiveListenerClient | null = null;
  let pendingRetry: unknown = null;
  let stopped = false;

  async function deliver(payload: string): Promise<void> {
    // A notification can arrive in the window between `stop()` and the
    // connection actually closing. Publishing then would write to sockets for a
    // relay that has been shut down — or, with the kill switch, for a relay the
    // operator has explicitly turned off.
    if (stopped) return;
    // A malformed or empty delta is dropped rather than treated as a delivery
    // failure: it is ephemeral by design, so there is nothing to repair and
    // nothing to retry.
    const envelope = deltaFromPayload(payload);
    if (!envelope) return;
    deps.hub.publish(envelope.topic, envelope.frame);
  }

  async function deliverStored(payload: string): Promise<void> {
    // Same shutdown window as `deliver`.
    if (stopped) return;
    try {
      const scope = await deps.jobEvents.findByIdWithScope(payload);
      if (!scope) return;
      // Every scope this job belongs to, so one write reaches all of them (issue
      // #100). A job with a single scope is the common case and publishes once;
      // the loop is what makes a second surface possible without the second
      // surface's absence being invisible.
      for (const envelope of relayEnvelopesFor(scope)) {
        deps.hub.publish(envelope.topic, envelope.frame);
      }
    } catch (error) {
      // A failed delivery is a gap in a live view, not a reason to tear the
      // listener down: the event is already durable in `job_events`, and the
      // poll fallback plus the next reconnect's catch-up read both still
      // surface it. Losing the socket is what we are here to avoid.
      report(`live relay: failed to deliver event ${payload}: ${describe(error)}`);
    }
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const listener = deps.clientFactory();
    client = listener;

    listener.on("notification", (message: { channel?: string; payload?: string }) => {
      if (typeof message?.payload !== "string" || message.payload === "") return;
      // Two channels, two delivery paths, deliberately: a stored event must be
      // read back (its notification carries only an id), while a delta is
      // self-contained because there is no row to read back. One shared path
      // would mean either storing deltas or looking up an id that never existed.
      if (message.channel === LIVE_JOB_EVENTS_CHANNEL) {
        void deliverStored(message.payload);
        return;
      }
      if (message.channel === LIVE_JOB_EVENT_DELTAS_CHANNEL) {
        void deliver(message.payload);
      }
    });

    // 'error' and 'end' both mean the subscription is gone. Reconnecting from
    // either is what keeps the relay from quietly becoming a no-op — a socket
    // client would keep its (now eventless) connection open and look healthy.
    const onLost = (reason: string) => {
      if (stopped || client !== listener) return;
      client = null;
      report(`live relay: ${reason}; retrying in ${retryDelayMs}ms`);
      void listener.end().catch(() => {});
      pendingRetry = scheduleRetry(() => {
        pendingRetry = null;
        void connect();
      }, retryDelayMs);
    };

    listener.on("error", (error: unknown) => onLost(`listener error: ${describe(error)}`));
    listener.on("end", () => onLost("listener connection ended"));

    try {
      await listener.connect();
      if (stopped) {
        await listener.end().catch(() => {});
        return;
      }
      // Both channels on one connection: LISTEN is connection-scoped state, so
      // a second channel costs nothing here and avoids a second dedicated
      // client per replica.
      await listener.query(`LISTEN ${LIVE_JOB_EVENTS_CHANNEL}`);
      await listener.query(`LISTEN ${LIVE_JOB_EVENT_DELTAS_CHANNEL}`);
    } catch (error) {
      onLost(`failed to establish listener: ${describe(error)}`);
    }
  }

  void connect();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (pendingRetry !== null) {
        cancelRetry(pendingRetry);
        pendingRetry = null;
      }
      const listener = client;
      client = null;
      if (listener) await listener.end().catch(() => {});
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
