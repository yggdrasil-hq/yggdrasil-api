import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { config } from "../config.js";
import type { SessionService } from "../auth/sessions.js";
import type { FeatureRepository } from "../features/repository.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { TestRepository } from "../tests/repository.js";
import type { UserRepository } from "../users/repository.js";
import { readCookie } from "./cookies.js";
import { authorizeScopeSubscription, SCOPE_AUTHORIZERS } from "./authorization.js";
import { FrameBudget, type FrameBudgetOptions } from "./limits.js";
import type { LiveConnection, LiveHub } from "./hub.js";
import {
  LIVE_CLOSE_PROTOCOL,
  LIVE_CLOSE_RATE_LIMITED,
  LIVE_CLOSE_UNAUTHORIZED,
  LIVE_PROTOCOL_VERSION,
  LIVE_SOCKET_PATH,
  liveTopicForScope,
  parseClientFrame,
  type LiveScope,
  type ServerFrame,
} from "./types.js";

/**
 * How many unparseable or unknown frames one connection may send before it is
 * closed. Zero tolerance would make a single stray frame from a slightly newer
 * client fatal; unbounded tolerance lets a broken client spin the process. A
 * small fixed budget is the middle (ADR 019 item 5).
 */
export const LIVE_MAX_PROTOCOL_ERRORS = 5;

/**
 * How many client frames may be buffered while authentication is in flight
 * (issue #77).
 *
 * The window is short — one session lookup — but it is a window an
 * **unauthenticated** peer controls, so an unbounded queue is a small
 * memory-exhaustion path: `ws`'s default `maxPayload` is 100 MiB, so a single
 * frame can be large and a fast sender can queue several.
 *
 * A real client sends one `subscribe` (or one `ping`) in this window, so 8 is
 * generous. Exceeding it is treated as a protocol failure and the socket is
 * closed, which is the honest outcome: a client that has sent eight frames before
 * the server finished a database lookup is not behaving like the protocol's
 * client.
 */
export const LIVE_MAX_EARLY_FRAMES = 8;

/**
 * How many bytes of early frames may be buffered (issue #77).
 *
 * A byte bound as well as a count bound, because the count alone bounds nothing:
 * 8 frames of 100 MiB is still 800 MiB. A real early frame is a `subscribe`
 * carrying two uuids — under 100 bytes — so 64 KiB is orders of magnitude above
 * legitimate use while keeping the worst case trivial.
 */
export const LIVE_MAX_EARLY_BYTES = 64 * 1024;

export interface LiveSocketDeps {
  /** The HTTP server to attach the upgrade listener to. */
  server: Server;
  sessions: SessionService;
  users: UserRepository;
  projects: ProjectRepository;
  features: FeatureRepository;
  /**
   * Issue #25: design sessions are `design_grill` jobs, and
   * `authorizeDesignSessionSubscription` mirrors the design-session events route by
   * resolving the session through this repository. A narrow `Pick` rather than the
   * whole `JobRepository` — the socket needs exactly one read from it, and naming
   * that read is what keeps this dependency honest about its purpose.
   */
  jobs: Pick<JobRepository, "findByIdForProject">;
  /**
   * Issue #90: a Test entity is resolved through this repository, so
   * `authorizeTestSubscription` can mirror the run-history route
   * (`tests.findById(project.id, testId)`) the way the socket's other two scopes
   * mirror their routes. A narrow `Pick` for the same reason `jobs` is one: the
   * socket needs exactly one read, and naming it keeps the dependency honest
   * about its purpose.
   */
  tests: Pick<TestRepository, "findById">;
  hub: LiveHub;
  onError?: (message: string) => void;
  path?: string;
  /**
   * Issue #24: budget options every accepted connection gets its own instance
   * of. Options rather than a shared `FrameBudget`, because a bucket is
   * per-connection state — sharing one would make the limit a cap on the whole
   * process's frame rate, which is not what is being bounded. Defaults to the
   * configured limits; injected by tests.
   */
  frameBudget?: FrameBudgetOptions;
}

export interface LiveSocketServer {
  /** Stops accepting upgrades and terminates the sockets this process holds. */
  close(): Promise<void>;
}

/**
 * A client frame received before authentication finished, held as its raw text.
 *
 * Kept as text rather than parsed: parsing twice (once here, once in the real
 * handler) would duplicate the protocol-error accounting, and a frame that is
 * malformed should produce its error exactly once, in the place that owns
 * `protocolErrors`.
 */
type EarlyFrame = string;

/** A hub connection that additionally remembers who it authenticated as. */
interface AuthedConnection extends LiveConnection {
  readonly userId: string;
}

/**
 * Serves the Web app's live event socket (ADR 019).
 *
 * Attached to the `http.Server`, not to the Express app: a WebSocket upgrade is
 * an HTTP event Express never sees, so there is no router to add to. That is
 * also why the session cookie is read off the raw request here rather than from
 * `req.cookies` (see `readCookie`), and why this takes the server the caller
 * already has instead of creating one — tests build an app without opening a
 * port, and only `index.ts` owns the real server.
 *
 * Authentication is the session cookie and nothing else: no token scheme, no
 * query-string credential (a URL would leak the session into logs, referrers
 * and history). A rejected connection is closed with an application code rather
 * than left open and silent, so a client can tell "not logged in" from "the
 * relay is down" and stop retrying instead of looping.
 *
 * The session is *not* touched on connect. Every authenticated REST call
 * already refreshes it, and the page keeps a (slower) poll running even while
 * connected — so a live socket cannot by itself keep a session alive from a
 * forgotten background tab, which is the property the session TTL relies on.
 */
export function createLiveSocketServer(deps: LiveSocketDeps): LiveSocketServer {
  const report = deps.onError ?? ((message: string) => console.error(message));
  const frameBudget: FrameBudgetOptions = deps.frameBudget ?? {
    burst: config.live.frameBurst,
    perSecond: config.live.framesPerSecond,
  };
  const wss = new WebSocketServer({
    server: deps.server,
    path: deps.path ?? LIVE_SOCKET_PATH,
  });

  wss.on("connection", (socket: WebSocket, request) => {
    // Issue #77: the socket's listener is attached **here**, synchronously,
    // before authentication starts — not inside `openConnection` after it
    // finishes. `ws` emits `message` only to listeners that already exist and
    // does not buffer, so a frame arriving during the session lookup used to be
    // delivered to nobody: no error, no `subscribed`, socket open and answering
    // `ping`. From the client's side that is indistinguishable from "subscribed,
    // nothing has happened yet" — forever.
    const pending: EarlyFrame[] = [];
    let pendingBytes = 0;
    let authenticated = false;
    let overflowed = false;

    socket.on("message", (data: RawData) => {
      const text = data.toString();
      if (authenticated) {
        // Steady state: hand straight to the connection's own queue, which
        // `openConnection` has by now installed.
        deliver(text);
        return;
      }
      if (overflowed) return;

      // Bounded on both axes. The count alone bounds nothing, because a single
      // frame may be up to `ws`'s `maxPayload` (100 MiB by default).
      pendingBytes += Buffer.byteLength(text);
      if (
        pending.length >= LIVE_MAX_EARLY_FRAMES ||
        pendingBytes > LIVE_MAX_EARLY_BYTES
      ) {
        overflowed = true;
        pending.length = 0;
        report(
          `live socket sent more than ${LIVE_MAX_EARLY_FRAMES} frames / ${LIVE_MAX_EARLY_BYTES} bytes before authenticating; closing`,
        );
        // Closed rather than ignored: a client that floods the pre-auth window
        // is not one to keep serving, and silence here would be the same defect
        // in a new place.
        reject(socket, "too many frames before authentication", LIVE_CLOSE_PROTOCOL);
        return;
      }
      pending.push(text);
    });

    // Set by `openConnection` once the real queue exists. Until then, early
    // frames are buffered; afterwards, `deliver` routes to it.
    let deliver: (text: string) => void = () => {};

    void openConnection(socket, request.headers.cookie, {
      claim: (enqueue) => {
        deliver = enqueue;
        authenticated = true;
        // Drained in arrival order. Ordering is enforced by the queue itself
        // (each frame waits for the previous to finish), so this loop only has
        // to preserve *arrival* order — which it does by iterating the buffer.
        const buffered = pending.splice(0, pending.length);
        for (const text of buffered) enqueue(text);
      },
    });
  });

  async function authenticate(cookieHeader: string | undefined) {
    const sessionId = readCookie(cookieHeader, config.cookieName);
    if (!sessionId) return null;
    const session = await deps.sessions.findValid(sessionId);
    if (!session) return null;
    return deps.users.findById(session.userId);
  }

  async function openConnection(
    socket: WebSocket,
    cookieHeader: string | undefined,
    early: { claim: (handler: (text: string) => void) => void },
  ) {
    let user;
    try {
      user = await authenticate(cookieHeader);
    } catch (error) {
      report(`live socket handshake failed: ${describe(error)}`);
      // The buffered frames are simply dropped with the socket. They must not be
      // replayed anywhere: they arrived from a peer whose identity was never
      // established, so processing them would be acting on an unauthenticated
      // client's behalf.
      socket.close(LIVE_CLOSE_PROTOCOL, "handshake failed");
      return;
    }
    if (!user) {
      // Same reasoning as above, and the reason buffering is safe at all: the
      // early-frame buffer belongs to a connection that may still turn out not
      // to be anyone.
      reject(socket, "Not authenticated", LIVE_CLOSE_UNAUTHORIZED);
      return;
    }

    let protocolErrors = 0;
    /**
     * Issue #24: this connection's own frame budget. See `limits.ts` for why the
     * limit is consulted here, in `send`, rather than in the hub's fan-out —
     * briefly, because this is the one path every outbound frame takes, including
     * the `pong` reply to a client's own `ping`, which is the only frame rate a
     * client controls outright.
     */
    const budget = new FrameBudget(frameBudget);
    const connection: AuthedConnection = {
      // Unique per socket, so two tabs of one user are two connections the hub
      // can clean up independently (ADR 019 item 9). The user id is prefixed
      // only so a log line about a connection identifies its owner.
      id: `${user.id}:${randomUUID()}`,
      userId: user.id,
      send(frame: ServerFrame) {
        if (socket.readyState !== WebSocket.OPEN) {
          // Thrown rather than dropped: the hub treats a throwing send as a
          // dead connection and prunes it, which is what keeps half-closed tabs
          // from accumulating in the fan-out sets.
          throw new Error("socket is not open");
        }
        if (!budget.take()) {
          // Closing, deliberately, rather than skipping the frame — see the long
          // note on `FrameBudget` for why. The short version: the Web app's REST
          // poll is a complete state path, so a closed socket costs the user
          // immediacy and never content, while a silent drop would be
          // invisible to both the client and the operator.
          //
          // The throw matters as much as the close: it is what makes the hub
          // prune this connection from its topics, so the budget bounds the
          // *fan-out work* as well as the socket's send cost. Without it, every
          // later event would still iterate this connection and be refused.
          report(
            `live socket ${connection.id} exceeded its frame budget (${frameBudget.perSecond}/s, burst ${frameBudget.burst}); closing`,
          );
          reject(socket, "rate limited", LIVE_CLOSE_RATE_LIMITED);
          throw new Error("frame budget exhausted");
        }
        socket.send(JSON.stringify(frame));
      },
    };

    socket.on("close", () => deps.hub.remove(connection));
    socket.on("error", (error: unknown) => {
      deps.hub.remove(connection);
      report(`live socket error: ${describe(error)}`);
    });

    /**
     * Frames are processed **one at a time, in arrival order** — see
     * `queueFrame` below. `handleFrame` does the work for a single frame.
     *
     * The serialization is not optional, and it is a genuine defect it fixes
     * rather than a precaution. `unsubscribe` is handled synchronously while
     * `subscribe` awaits an authorisation query, so two frames sent together
     * (`subscribe` then `unsubscribe`) used to complete **out of order**: the
     * client received `unsubscribed` before `subscribed` and the connection was
     * left in the hub as a subscriber when its last stated intent was to leave.
     * A stale subscription is not cosmetic — it keeps delivering events to a
     * client that asked to stop, and it holds a hub entry the client cannot
     * remove because it believes it already did.
     *
     * Verified to be pre-existing rather than introduced by the early-frame
     * buffering: the same two frames sent *after* `ready` reproduce it. Buffering
     * only made it easier to hit, which is how it was found.
     */
    async function handleFrame(text: string): Promise<void> {
      const frame = parseClientFrame(text);
      if (!frame) {
        protocolErrors += 1;
        if (protocolErrors >= LIVE_MAX_PROTOCOL_ERRORS) {
          deps.hub.remove(connection);
          socket.close(LIVE_CLOSE_PROTOCOL, "too many invalid frames");
          return;
        }
        safeSend(connection, { type: "error", message: "Unrecognised frame" });
        return;
      }

      if (frame.type === "ping") {
        safeSend(connection, { type: "pong" });
        return;
      }

      if (frame.type === "unsubscribe") {
        // Synchronous, deliberately: unsubscribing needs no authorisation query,
        // and `queueFrame` serialises on *completion*, so a preceding `subscribe`
        // has already finished its query by the time this runs.
        deps.hub.unsubscribe(connection, liveTopicForScope(frame.scope));
        safeSend(connection, { type: "unsubscribed", scope: frame.scope });
        return;
      }

      // Awaited rather than fired and forgotten: `subscribe` does an
      // authorisation query, and returning before it resolves is what let a
      // later frame overtake it (see the note on `queueFrame`).
      await subscribe(connection, frame.projectId, frame.scope);
    }

    /**
     * A per-connection promise chain: each frame's handling is appended after the
     * previous one has *finished*, not merely after it was started.
     *
     * A chain rather than a queue of buffered frames because the order that
     * matters is completion order, and a `subscribe` that has started but not
     * resolved is not yet "processed". Serializing on completion is what makes
     * `subscribe` → `unsubscribe` sent together end up unsubscribed.
     *
     * Rejections are swallowed per link so one failing frame cannot break the
     * chain for every frame after it — `handleFrame` reports its own failures and
     * a poisoned chain would silently stop responding, which is the class of bug
     * this whole file exists to avoid.
     */
    let frameChain: Promise<void> = Promise.resolve();
    function queueFrame(text: string): void {
      frameChain = frameChain
        .then(() => handleFrame(text))
        .catch((error: unknown) => {
          report(`live socket frame handling failed: ${describe(error)}`);
        });
    }

    // `ready` is sent **before** the buffered frames are drained, and that order
    // is the protocol's, not an implementation detail: `ready` announces the
    // protocol version, and a client that subscribed early is entitled to see it
    // before the `subscribed` reply. Reversing these would make the early and
    // late paths produce different frame sequences for the same client.
    safeSend(connection, { type: "ready", protocolVersion: LIVE_PROTOCOL_VERSION });

    // Drains any frames that arrived during authentication, in order.
    early.claim(queueFrame);
  }

  /**
   * Handles one `subscribe` frame, for whichever scope it names (ADR 033 §2).
   *
   * **One function where version 1 had three**, and the difference is the point of
   * ADR 033: the per-scope copies differed in exactly three places — the authoriser,
   * the topic function and the reply frame — and each of those is now selected by
   * the scope's `kind` from a registry rather than by a branch written here. So a
   * new scope does not edit this function at all, which is what made the third
   * scope cheap rather than the fourth copy of a shape.
   *
   * What it deliberately still does *not* abstract is the authorisation itself:
   * `authorizeScopeSubscription` selects one of three authorisers that each resolve
   * their resource inside a project the caller is a member of. A shared
   * `(projectId, id)` check would be the looser gate ADR 033 §2 forbids.
   *
   * It sends no state on success: it adds the socket to a topic and returns, leaving
   * the page's REST read as the only state path (ADR 019 item 7). The reply echoes
   * the scope, so the client can confirm that *this* subscription was accepted
   * rather than inferring it from the frame's type — which is the check that replaces
   * version 1's per-scope confirmation frame names.
   */
  async function subscribe(
    connection: AuthedConnection,
    projectId: string,
    scope: LiveScope,
  ): Promise<void> {
    const authorizer = SCOPE_AUTHORIZERS[scope.kind];
    let decision;
    try {
      // Re-authorised on every subscribe frame, never remembered from an earlier
      // frame on the same socket (see `authorizeScopeSubscription`).
      decision = await authorizeScopeSubscription(deps, {
        userId: connection.userId,
        projectId,
        scope,
      });
    } catch (error) {
      report(`live socket subscribe failed: ${describe(error)}`);
      safeSend(connection, { type: "error", message: "Subscription failed" });
      return;
    }

    if (!decision.ok) {
      // One message per scope, and one for both of that scope's refusals — matching
      // the REST route's single 404 for a project the caller cannot see and a
      // resource that is not there, the same non-disclosure rule as before
      // (ADR 019 item 3). The kind is not a secret, so naming it costs nothing and
      // keeps a refusal diagnosable; the *reason* is logged rather than sent.
      safeSend(connection, { type: "error", message: authorizer.refusalMessage });
      return;
    }

    deps.hub.subscribe(connection, liveTopicForScope(scope));
    safeSend(connection, { type: "subscribed", scope });
  }

  return {
    async close(): Promise<void> {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

/**
 * Sends without letting a torn-down socket become an unhandled rejection mid
 * frame handling. The hub's `publish` still sees the throw from
 * `connection.send` and prunes the connection; this is only for frames the
 * handler itself originates.
 */
function safeSend(connection: LiveConnection, frame: ServerFrame): void {
  try {
    connection.send(frame);
  } catch {
    // Nothing to do: the close/error handlers remove the connection.
  }
}

function reject(socket: WebSocket, message: string, code: number): void {
  try {
    socket.send(JSON.stringify({ type: "error", message } satisfies ServerFrame));
  } catch {
    // A socket that cannot even receive the rejection is still closed below.
  }
  socket.close(code, message);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
