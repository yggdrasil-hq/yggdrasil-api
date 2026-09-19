import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { LiveHub } from "./hub.js";
import { createLiveSocketServer, type LiveSocketServer } from "./socket.js";
import { LIVE_SOCKET_PATH, type ServerFrame } from "./types.js";
import type { SessionRecord } from "../auth/sessions.js";

/**
 * Issue #77: a `subscribe` sent before the server's `ready` frame was silently
 * dropped — no `subscribed`, no `error`, socket open and answering `ping`.
 *
 * **Why a real socket and a real server.** `socket.test.ts` drives the server's
 * handlers directly, so the window between "socket upgraded" and "auth finished"
 * does not exist in it: there is no asynchronous handshake to lose a frame in.
 * The bug lives exactly in that window, so only a real client against a real
 * server can see it — the same lesson as #43, #56 and #69, where a green suite
 * said nothing about the thing that was broken.
 *
 * The authentication delay is what makes the window wide enough to hit
 * deterministically. Without it the race is real but usually won by the server,
 * and a test that passes 99% of the time is worse than no test: it reports the
 * bug as fixed whenever the scheduler happens to cooperate.
 */

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FEATURE_ID = "22222222-2222-4222-8222-222222222222";
const GOOD_COOKIE = "yggdrasil_session=sess_1";

/** How long the fake session lookup takes. Wide enough to send frames inside it. */
const AUTH_DELAY_MS = 120;

interface Harness {
  port: number;
  hub: LiveHub;
  close: () => Promise<void>;
  /** Frames the server was asked to authorise, to prove buffered work ran. */
  authorizeCalls: () => number;
}

const open: Array<{ server: Server; live: LiveSocketServer }> = [];

afterEach(async () => {
  for (const { server, live } of open.splice(0)) {
    await live.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
});

async function withRelay(
  run: (h: Harness) => Promise<void>,
  options: { authenticated?: boolean } = {},
): Promise<void> {
  const httpServer = createServer();
  const hub = new LiveHub();
  const authorizeCalls = { count: 0 };
  const authenticated = options.authenticated ?? true;

  const live = createLiveSocketServer({
    server: httpServer,
    sessions: {
      findValid: vi.fn(async (): Promise<SessionRecord | null> => {
        // The deliberate delay: it is the window the bug lives in.
        await new Promise((resolve) => setTimeout(resolve, AUTH_DELAY_MS));
        // `null` models an expired or unknown session — the case where a
        // buffered frame must be discarded rather than replayed.
        return authenticated ? ({ id: "sess_1", userId: "user_1" } as SessionRecord) : null;
      }),
      touch: vi.fn(async () => undefined),
    } as never,
    users: { findById: vi.fn(async () => ({ id: "user_1" })) } as never,
    projects: {
      findByIdForUser: vi.fn(async () => {
        authorizeCalls.count += 1;
        return { id: PROJECT_ID };
      }),
    } as never,
    features: { findById: vi.fn(async () => ({ id: FEATURE_ID, projectId: PROJECT_ID })) } as never,
    hub,
    onError: () => {},
  });

  open.push({ server: httpServer, live });
  const port = await new Promise<number>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve(address.port);
    });
  });

  await run({
    port,
    hub,
    close: async () => {
      await live.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
    authorizeCalls: () => authorizeCalls.count,
  });
}

interface Client {
  socket: WebSocket;
  frames: ServerFrame[];
  closed: () => { code: number; reason: string } | null;
  send: (frame: unknown) => void;
}

function connect(port: number): Client {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${LIVE_SOCKET_PATH}`, {
    headers: { cookie: GOOD_COOKIE },
  });
  const frames: ServerFrame[] = [];
  let closeInfo: { code: number; reason: string } | null = null;

  socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerFrame));
  socket.on("close", (code, reason) => {
    closeInfo = { code, reason: reason.toString() };
  });
  socket.on("error", () => {});

  return { socket, frames, closed: () => closeInfo, send: (frame) => socket.send(JSON.stringify(frame)) };
}

async function waitFor(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const subscribeFrame = { type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID };

describe("live socket: a frame sent before `ready` (issue #77)", () => {
  it("still subscribes when the client sends subscribe on open, before the handshake completes", async () => {
    await withRelay(async ({ port }) => {
      const client = connect(port);

      // The natural thing for a client to write: subscribe as soon as the socket
      // opens. The server has not finished authenticating yet.
      client.socket.on("open", () => client.send(subscribeFrame));

      await waitFor(() => client.frames.some((f) => f.type === "subscribed"), "subscribed");

      const subscribed = client.frames.find((f) => f.type === "subscribed");
      expect(subscribed).toMatchObject({ type: "subscribed", featureId: FEATURE_ID });
      expect(client.closed()).toBeNull();
    });
  });

  it("delivers events to a socket that subscribed early", async () => {
    // The consequence that matters: `subscribed` is only useful if the
    // subscription is real, so this publishes through the hub and proves the
    // connection was actually registered — not merely that a frame was sent.
    await withRelay(async ({ port, hub }) => {
      const client = connect(port);
      client.socket.on("open", () => client.send(subscribeFrame));
      await waitFor(() => client.frames.some((f) => f.type === "subscribed"), "subscribed");

      const frame: ServerFrame = {
        type: "job_event",
        featureId: FEATURE_ID,
        jobId: "job_1",
        event: {
          id: "event_1",
          jobId: "job_1",
          type: "agent_text",
          question: null,
          markdown: null,
          message: "hello",
          status: null,
          prUrl: null,
          summary: null,
          actionItems: null,
          snapshot: null,
          createdAt: "2026-09-18T10:00:00.000Z",
        },
      };
      // A non-zero return is the hub's own statement that it had a subscriber
      // for this topic.
      expect(hub.publish(`feature:${FEATURE_ID}`, frame)).toBe(1);
      await waitFor(() => client.frames.some((f) => f.type === "job_event"), "the event");
    });
  });

  it("applies early frames in the order they arrived, not the order they finish", async () => {
    // The ordering property, and it is subtler than "drain in order". Two frames
    // sent together — `subscribe` then `unsubscribe` — must leave the connection
    // **unsubscribed**, because that is the client's last stated intent.
    //
    // Draining the buffer in arrival order is necessary but *not* sufficient:
    // `unsubscribe` is handled synchronously while `subscribe` awaits an
    // authorisation query, so a naive drain lets the later frame finish first and
    // the connection ends up subscribed when the client asked not to be. That is
    // a stale subscription, and it is what this asserts against.
    await withRelay(async ({ port, hub }) => {
      const client = connect(port);
      client.socket.on("open", () => {
        client.send(subscribeFrame);
        client.send({ type: "unsubscribe", featureId: FEATURE_ID });
      });

      await waitFor(
        () => client.frames.some((f) => f.type === "subscribed"),
        "the subscribe to be processed",
      );
      // Both frames have been handled by now; a publish must reach nobody.
      await new Promise((resolve) => setTimeout(resolve, 120));

      const frame: ServerFrame = {
        type: "job_event",
        featureId: FEATURE_ID,
        jobId: "job_1",
        event: {
          id: "event_1",
          jobId: "job_1",
          type: "agent_text",
          question: null,
          markdown: null,
          message: "hello",
          status: null,
          prUrl: null,
          summary: null,
          actionItems: null,
          snapshot: null,
          createdAt: "2026-09-18T10:00:00.000Z",
        },
      };
      expect(hub.publish(`feature:${FEATURE_ID}`, frame)).toBe(0);
    });
  });

  it("rejects a non-uuid subscribe sent early, rather than losing it", async () => {
    // An invalid early frame must produce the same protocol error it would
    // produce later — losing it silently is the bug, whichever frame it is.
    await withRelay(async ({ port }) => {
      const client = connect(port);
      client.socket.on("open", () =>
        client.send({ type: "subscribe", projectId: "not-a-uuid", featureId: FEATURE_ID }),
      );

      await waitFor(() => client.frames.some((f) => f.type === "error"), "an error frame");
      expect(client.frames.find((f) => f.type === "error")).toMatchObject({
        type: "error",
        message: "Unrecognised frame",
      });
    });
  });

  it("does not act on frames sent by a client that then fails authentication", async () => {
    // The security property of buffering: a frame that arrived while
    // unauthenticated must never be processed as an authenticated client's. Here
    // the session is invalid, so nothing the socket sent may reach the
    // authorisation path.
    await withRelay(async ({ port, authorizeCalls }) => {
      const client = connect(port);
      client.socket.on("open", () => client.send(subscribeFrame));

      await waitFor(() => client.closed() !== null, "the socket to be closed");
      // Give any (incorrect) deferred processing a chance to run.
      await new Promise((resolve) => setTimeout(resolve, AUTH_DELAY_MS + 80));

      expect(authorizeCalls()).toBe(0);
      expect(client.closed()?.code).toBe(4401);
    }, { authenticated: false });
  });
});
