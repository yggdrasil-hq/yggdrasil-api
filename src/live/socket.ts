import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { config } from "../config.js";
import type { SessionService } from "../auth/sessions.js";
import type { FeatureRepository } from "../features/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { UserRepository } from "../users/repository.js";
import { readCookie } from "./cookies.js";
import { authorizeSubscription } from "./authorization.js";
import type { LiveConnection, LiveHub } from "./hub.js";
import {
  LIVE_CLOSE_PROTOCOL,
  LIVE_CLOSE_UNAUTHORIZED,
  LIVE_PROTOCOL_VERSION,
  LIVE_SOCKET_PATH,
  liveTopicForFeature,
  parseClientFrame,
  type ServerFrame,
} from "./types.js";

/**
 * How many unparseable or unknown frames one connection may send before it is
 * closed. Zero tolerance would make a single stray frame from a slightly newer
 * client fatal; unbounded tolerance lets a broken client spin the process. A
 * small fixed budget is the middle (ADR 019 item 5).
 */
export const LIVE_MAX_PROTOCOL_ERRORS = 5;

export interface LiveSocketDeps {
  /** The HTTP server to attach the upgrade listener to. */
  server: Server;
  sessions: SessionService;
  users: UserRepository;
  projects: ProjectRepository;
  features: FeatureRepository;
  hub: LiveHub;
  onError?: (message: string) => void;
  path?: string;
}

export interface LiveSocketServer {
  /** Stops accepting upgrades and terminates the sockets this process holds. */
  close(): Promise<void>;
}

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
  const wss = new WebSocketServer({
    server: deps.server,
    path: deps.path ?? LIVE_SOCKET_PATH,
  });

  wss.on("connection", (socket: WebSocket, request) => {
    void openConnection(socket, request.headers.cookie);
  });

  async function authenticate(cookieHeader: string | undefined) {
    const sessionId = readCookie(cookieHeader, config.cookieName);
    if (!sessionId) return null;
    const session = await deps.sessions.findValid(sessionId);
    if (!session) return null;
    return deps.users.findById(session.userId);
  }

  async function openConnection(socket: WebSocket, cookieHeader: string | undefined) {
    let user;
    try {
      user = await authenticate(cookieHeader);
    } catch (error) {
      report(`live socket handshake failed: ${describe(error)}`);
      socket.close(LIVE_CLOSE_PROTOCOL, "handshake failed");
      return;
    }
    if (!user) {
      reject(socket, "Not authenticated", LIVE_CLOSE_UNAUTHORIZED);
      return;
    }

    let protocolErrors = 0;
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
        socket.send(JSON.stringify(frame));
      },
    };

    socket.on("close", () => deps.hub.remove(connection));
    socket.on("error", (error: unknown) => {
      deps.hub.remove(connection);
      report(`live socket error: ${describe(error)}`);
    });

    socket.on("message", (data: RawData) => {
      const frame = parseClientFrame(data.toString());
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
        deps.hub.unsubscribe(connection, liveTopicForFeature(frame.featureId));
        safeSend(connection, { type: "unsubscribed", featureId: frame.featureId });
        return;
      }

      void subscribe(connection, frame.projectId, frame.featureId);
    });

    safeSend(connection, { type: "ready", protocolVersion: LIVE_PROTOCOL_VERSION });
  }

  async function subscribe(
    connection: AuthedConnection,
    projectId: string,
    featureId: string,
  ): Promise<void> {
    let decision;
    try {
      // Re-authorised on every subscribe frame, never remembered from an
      // earlier frame on the same socket (see authorizeSubscription).
      decision = await authorizeSubscription(deps, {
        userId: connection.userId,
        projectId,
        featureId,
      });
    } catch (error) {
      report(`live socket subscribe failed: ${describe(error)}`);
      safeSend(connection, { type: "error", message: "Subscription failed" });
      return;
    }

    if (!decision.ok) {
      // One message for both refusals, matching the REST route's 404 for a
      // project that does not exist and one the caller cannot see.
      safeSend(connection, { type: "error", message: "Feature not found" });
      return;
    }

    deps.hub.subscribe(connection, liveTopicForFeature(featureId));
    safeSend(connection, { type: "subscribed", featureId });
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
