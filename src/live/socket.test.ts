import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { LiveHub } from "./hub.js";
import { LIVE_MAX_PROTOCOL_ERRORS, createLiveSocketServer } from "./socket.js";
import {
  LIVE_CLOSE_PROTOCOL,
  LIVE_CLOSE_RATE_LIMITED,
  LIVE_CLOSE_UNAUTHORIZED,
  LIVE_PROTOCOL_VERSION,
  LIVE_SOCKET_PATH,
} from "./types.js";
import type { ServerFrame } from "./types.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "55555555-5555-4555-8555-555555555555";
const ORPHAN_USER_ID = "77777777-7777-4777-8777-777777777777";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PROJECT_ID = "99999999-9999-4999-8999-999999999999";
const FEATURE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_FEATURE_ID = "66666666-6666-4666-8666-666666666666";

const GOOD_COOKIE = `${config.cookieName}=sess_ok`;

const servers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const shutdown of servers.splice(0)) await shutdown();
});

/**
 * Stands up a real HTTP server with the relay attached and drives it with a
 * real `ws` client. The relay's whole job is an HTTP upgrade plus frame
 * handling, so exercising it through a fake socket object would test the
 * harness rather than the thing that ships — this is the only test in the repo
 * that opens a port, which is why it is self-contained.
 */
async function withRelay(
  run: (context: { port: number; hub: LiveHub }) => Promise<void>,
  options: {
    onError?: (message: string) => void;
    /** Issue #24: injected so the frame budget's boundary is exercised, not waited on. */
    frameBudget?: { burst: number; perSecond: number };
  } = {},
) {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const hub = new LiveHub();

  const sessions = {
    findValid: vi.fn(async (id: string) => {
      if (id === "sess_ok") return { id: "sess_ok", userId: USER_ID };
      if (id === "sess_other") return { id: "sess_other", userId: OTHER_USER_ID };
      // A session that is still valid but whose owner no longer resolves — a
      // deleted user, or a row left behind by a bad migration.
      if (id === "sess_orphan") return { id: "sess_orphan", userId: ORPHAN_USER_ID };
      return null;
    }),
  };
  const users = {
    findById: vi.fn(async (id: string) =>
      id === USER_ID || id === OTHER_USER_ID ? { id } : null,
    ),
  };
  // Models org-membership scoping: the project resolves only for its member,
  // exactly as `findByIdForUser`'s join does.
  const projects = {
    findByIdForUser: vi.fn(async (projectId: string, userId: string) =>
      projectId === PROJECT_ID && userId === USER_ID ? { id: PROJECT_ID } : null,
    ),
  };
  const features = {
    findById: vi.fn(async (projectId: string, featureId: string) =>
      projectId === PROJECT_ID && featureId === FEATURE_ID ? { id: FEATURE_ID } : null,
    ),
  };

  const sockets = createLiveSocketServer({
    server,
    hub,
    sessions: sessions as never,
    users: users as never,
    projects: projects as never,
    features: features as never,
    onError: options.onError,
    frameBudget: options.frameBudget,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  servers.push(async () => {
    await sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  await run({ port, hub });
}

interface Client {
  socket: WebSocket;
  frames: ServerFrame[];
  closed: () => { code: number; reason: string } | null;
  send: (frame: unknown) => void;
}

function connect(port: number, cookie?: string): Client {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${LIVE_SOCKET_PATH}`, {
    headers: cookie ? { cookie } : {},
  });
  const frames: ServerFrame[] = [];
  let closeInfo: { code: number; reason: string } | null = null;

  socket.on("message", (data) => frames.push(JSON.parse(data.toString()) as ServerFrame));
  socket.on("close", (code, reason) => {
    closeInfo = { code, reason: reason.toString() };
  });
  socket.on("error", () => {
    // A rejected upgrade or a closed socket surfaces here too; the assertions
    // read frames/close info, so swallow it rather than failing the run.
  });

  return {
    socket,
    frames,
    closed: () => closeInfo,
    send: (frame) => socket.send(JSON.stringify(frame)),
  };
}

/**
 * Connects, waits for the handshake, and subscribes to the fixture feature.
 *
 * Two frames pass through the connection's budget before this resolves (`ready`
 * and `subscribed`), which the frame-budget tests below have to account for —
 * hence one helper rather than the same three lines repeated, where a forgotten
 * `subscribe` would make `hub.publish` return 0 for the wrong reason and the
 * assertion would pass while testing nothing.
 */
async function subscribedClient(port: number): Promise<Client> {
  const client = connect(port, GOOD_COOKIE);
  await waitFor(() => client.frames.length > 0, "ready");
  client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
  await waitFor(() => client.frames.some((frame) => frame.type === "subscribed"), "subscribed");
  return client;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets a frame's round trip complete, then reads the frames received so far. */
async function settle(client: Client): Promise<ServerFrame[]> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  return client.frames;
}

function jobEventFrame(): ServerFrame {
  return {
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
}

describe("live socket: authentication", () => {
  it("rejects a connection with no session cookie", async () => {
    await withRelay(async ({ port }) => {
      const client = connect(port);
      await waitFor(() => client.closed() !== null, "close");

      expect(client.closed()?.code).toBe(LIVE_CLOSE_UNAUTHORIZED);
      expect(client.frames).toContainEqual({ type: "error", message: "Not authenticated" });
    });
  });

  it("rejects an expired or unknown session", async () => {
    await withRelay(async ({ port }) => {
      const client = connect(port, `${config.cookieName}=sess_gone`);
      await waitFor(() => client.closed() !== null, "close");

      expect(client.closed()?.code).toBe(LIVE_CLOSE_UNAUTHORIZED);
    });
  });

  it("rejects a valid session whose user no longer resolves", async () => {
    await withRelay(async ({ port }) => {
      const client = connect(port, `${config.cookieName}=sess_orphan`);
      await waitFor(() => client.closed() !== null, "close");

      expect(client.closed()?.code).toBe(LIVE_CLOSE_UNAUTHORIZED);
    });
  });

  it("accepts a valid session and announces the protocol version", async () => {
    await withRelay(async ({ port }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      expect(client.frames[0]).toEqual({
        type: "ready",
        protocolVersion: LIVE_PROTOCOL_VERSION,
      });
    });
  });
});

describe("live socket: subscription authorisation", () => {
  it("subscribes a member to their own feature and receives published events", async () => {
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "subscribed"),
        "subscribed",
      );

      expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(1);
      const frames = await settle(client);
      expect(frames).toContainEqual(jobEventFrame());
    });
  });

  it("refuses a project the caller is not a member of, and delivers nothing", async () => {
    // The isolation case: another organization's project id must not become a
    // readable event stream, and the refusal must be indistinguishable from a
    // project that does not exist.
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe", projectId: OTHER_PROJECT_ID, featureId: FEATURE_ID });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "error"),
        "refusal",
      );

      const frames = await settle(client);
      expect(frames).toContainEqual({ type: "error", message: "Feature not found" });
      expect(frames.some((frame) => frame.type === "subscribed")).toBe(false);

      // And the crucial half: publishing to that feature reaches nobody.
      expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(0);
      const afterPublish = await settle(client);
      expect(afterPublish.some((frame) => frame.type === "job_event")).toBe(false);
    });
  });

  it("refuses a feature id that is not in the authorised project", async () => {
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: OTHER_FEATURE_ID });
      await waitFor(() => client.frames.some((frame) => frame.type === "error"), "refusal");

      expect(hub.subscriberCount(`feature:${OTHER_FEATURE_ID}`)).toBe(0);
      const frames = await settle(client);
      expect(frames.some((frame) => frame.type === "subscribed")).toBe(false);
    });
  });

  it("refuses a malformed subscribe frame without closing the connection", async () => {
    await withRelay(async ({ port }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe", projectId: "nope", featureId: FEATURE_ID });
      await waitFor(() => client.frames.some((frame) => frame.type === "error"), "error");

      expect(client.closed()).toBeNull();
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  it("subscribes a feature with no active job, so a later run is not missed", async () => {
    // Subscription is by feature, not by job: a retry (ADR 012) or a restart
    // (ADR 024) creates a new job row, and the socket must follow the feature
    // across it rather than being pinned to the job that existed at connect
    // time.
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
      await waitFor(() => client.frames.some((frame) => frame.type === "subscribed"), "subscribed");

      const laterRun = jobEventFrame();
      hub.publish(`feature:${FEATURE_ID}`, {
        ...(laterRun as Extract<ServerFrame, { type: "job_event" }>),
        jobId: "job_2",
        event: { ...(laterRun as Extract<ServerFrame, { type: "job_event" }>).event, jobId: "job_2" },
      });

      const frames = await settle(client);
      expect(frames).toContainEqual(expect.objectContaining({ type: "job_event", jobId: "job_2" }));
    });
  });
});

describe("live socket: connection lifecycle", () => {
  it("answers ping with pong", async () => {
    await withRelay(async ({ port }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "ping" });
      await waitFor(() => client.frames.some((frame) => frame.type === "pong"), "pong");
    });
  });

  it("unsubscribes on request and stops receiving", async () => {
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
      await waitFor(() => client.frames.some((frame) => frame.type === "subscribed"), "subscribed");

      client.send({ type: "unsubscribe", featureId: FEATURE_ID });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "unsubscribed"),
        "unsubscribed",
      );

      expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(0);
      const frames = await settle(client);
      expect(frames.some((frame) => frame.type === "job_event")).toBe(false);
    });
  });

  it("keeps two tabs independent", async () => {
    await withRelay(async ({ port, hub }) => {
      const first = connect(port, GOOD_COOKIE);
      const second = connect(port, GOOD_COOKIE);
      await waitFor(() => first.frames.length > 0 && second.frames.length > 0, "ready");

      for (const client of [first, second]) {
        client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
      }
      await waitFor(() => first.frames.some((f) => f.type === "subscribed"), "subscribed");
      await waitFor(() => second.frames.some((f) => f.type === "subscribed"), "subscribed");
      expect(hub.subscriberCount(`feature:${FEATURE_ID}`)).toBe(2);

      first.socket.close();
      await waitFor(() => hub.subscriberCount(`feature:${FEATURE_ID}`) === 1, "one subscriber");
      expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(1);
      const secondFrames = await settle(second);
      expect(secondFrames.some((frame) => frame.type === "job_event")).toBe(true);
    });
  });

  it("drops the connection from the hub when it closes", async () => {
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");
      client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
      await waitFor(() => hub.subscriberCount(`feature:${FEATURE_ID}`) === 1, "subscribed");

      client.socket.close();
      await waitFor(() => hub.subscriberCount(`feature:${FEATURE_ID}`) === 0, "cleanup");
      expect(hub.connectionCount()).toBe(0);
    });
  });

  it("closes a client that sends too many invalid frames", async () => {
    await withRelay(
      async ({ port }) => {
        const client = connect(port, GOOD_COOKIE);
        await waitFor(() => client.frames.length > 0, "ready");

        for (let i = 0; i < LIVE_MAX_PROTOCOL_ERRORS; i += 1) {
          client.socket.send("not json");
        }
        await waitFor(() => client.closed() !== null, "close");
        expect(client.closed()?.code).toBe(LIVE_CLOSE_PROTOCOL);
      },
      { onError: () => {} },
    );
  });

  it("ignores an upgrade on a different path", async () => {
    await withRelay(async ({ port }) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/not-the-relay`);
      const failed = await new Promise<boolean>((resolve) => {
        socket.on("error", () => resolve(true));
        socket.on("open", () => resolve(false));
      });
      expect(failed).toBe(true);
    });
  });
});

describe("live socket: connection identity", () => {
  it("gives each socket a distinct connection id", async () => {
    // Two tabs of one user must be independently removable; sharing an id would
    // make closing one tab unsubscribe the other.
    await withRelay(async ({ port, hub }) => {
      const first = connect(port, GOOD_COOKIE);
      const second = connect(port, GOOD_COOKIE);
      await waitFor(() => first.frames.length > 0 && second.frames.length > 0, "ready");

      for (const client of [first, second]) {
        client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
      }
      await waitFor(() => hub.subscriberCount(`feature:${FEATURE_ID}`) === 2, "both");

      first.socket.close();
      await waitFor(() => hub.subscriberCount(`feature:${FEATURE_ID}`) === 1, "one left");
    });
  });

  it("refuses a second user's session for another user's project", async () => {
    // Cross-user isolation, not just cross-project: the project only resolves
    // for the member of its organization, so a different authenticated user is
    // refused by the same path a non-member is.
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, `${config.cookieName}=sess_other`);
      await waitFor(() => client.frames.length > 0, "ready");
      expect(client.frames[0]).toEqual({ type: "ready", protocolVersion: LIVE_PROTOCOL_VERSION });

      client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
      await waitFor(() => client.frames.some((frame) => frame.type === "error"), "refusal");

      const frames = await settle(client);
      expect(frames).toContainEqual({ type: "error", message: "Feature not found" });
      expect(frames.some((frame) => frame.type === "subscribed")).toBe(false);
      expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(0);
    });
  });
});

/*
 * Issue #24: the per-socket frame budget. Driven through a real socket rather
 * than a fake connection object, because the decision under test is what the
 * *client* experiences — a close with a code it can act on — and because the
 * budget lives inside `connection.send`, which only the real server path
 * exercises.
 *
 * These are the three boundary cases the issue asks for (under, at, over),
 * plus the chosen failure behaviour.
 */
describe("live socket frame budget (issue #24)", () => {
  it("delivers up to the budget and then closes with the rate-limit code", async () => {
    await withRelay(
      async ({ port, hub }) => {
        const client = await subscribedClient(port);

        // The bucket starts full at `burst`. `ready` and `subscribed` are the two
        // frames already spent through it, so exactly `burst - 2` more are served.
        const burst = 5;
        for (let i = 0; i < burst - 2; i += 1) {
          expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame()), `publish ${i + 1}`).toBe(1);
        }

        // The next one is over budget: it is not delivered, and it closes the
        // connection rather than being silently skipped.
        expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(0);

        await waitFor(() => client.closed() !== null, "close");
        expect(client.closed()?.code).toBe(LIVE_CLOSE_RATE_LIMITED);
      },
      { frameBudget: { burst: 5, perSecond: 1 } },
    );
  });

  it("counts the frames the budget was spent on, not the publishes that followed", async () => {
    // The load-bearing consequence of `send` throwing: the hub prunes the
    // connection, so the budget bounds *fan-out work* as well as send cost.
    // Without the throw, every later publish would still iterate this socket.
    await withRelay(
      async ({ port, hub }) => {
        const client = await subscribedClient(port);

        // `ready` and `subscribed` spent two of the three tokens; the third
        // delivers, and the next trips the budget.
        expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(1);
        expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(0);
        await waitFor(() => client.closed() !== null, "close");

        // The pruning is the point: the socket is gone from the topic's
        // subscriber set, which is what every later publish would otherwise
        // iterate. A budget that only refused at send time would leave the work
        // growing with the number of exhausted sockets.
        expect(hub.subscriberCount(`feature:${FEATURE_ID}`)).toBe(0);
        expect(hub.connectionCount()).toBe(0);
      },
      { frameBudget: { burst: 3, perSecond: 1 } },
    );
  });

  it("does not close a socket that stays under budget", async () => {
    // The budget must be invisible to ordinary use. A sustained rate of 1000/s
    // with a large burst is far above anything the product produces, so nothing
    // here should trip it however many frames are published.
    await withRelay(
      async ({ port, hub }) => {
        const client = await subscribedClient(port);

        for (let i = 0; i < 50; i += 1) {
          expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame()), `publish ${i}`).toBe(1);
        }

        expect(client.closed()).toBeNull();
      },
      { frameBudget: { burst: 500, perSecond: 1000 } },
    );
  });

  it("bounds a client's own ping flood, which is the frame rate it controls outright", async () => {
    // A client can send `ping` as fast as it likes and gets a `pong` for each —
    // the one outbound frame rate a client fully controls. Budgeting in `send`
    // rather than in the hub's fan-out is what catches this; a budget in the hub
    // would never see a pong.
    await withRelay(
      async ({ port }) => {
        const client = connect(port, GOOD_COOKIE);
        await waitFor(() => client.frames.length > 0, "ready");

        for (let i = 0; i < 20; i += 1) client.send({ type: "ping" });

        await waitFor(() => client.closed() !== null, "close");
        expect(client.closed()?.code).toBe(LIVE_CLOSE_RATE_LIMITED);
      },
      { frameBudget: { burst: 5, perSecond: 1 } },
    );
  });

  it("reports the limit it enforced, so an operator can tell which knob to turn", async () => {
    const reported: string[] = [];
    await withRelay(
      async ({ port, hub }) => {
        const client = await subscribedClient(port);

        // `ready` and `subscribed` spent two of the three; the first publish
        // delivers and the second trips it.
        hub.publish(`feature:${FEATURE_ID}`, jobEventFrame());
        hub.publish(`feature:${FEATURE_ID}`, jobEventFrame());
        expect(client.closed()).toBeNull();
        await waitFor(() => client.closed() !== null, "close");
        await waitFor(() => reported.length > 0, "the report");
      },
      { onError: (message) => reported.push(message), frameBudget: { burst: 3, perSecond: 7 } },
    );

    expect(reported.some((m) => m.includes("frame budget") && m.includes("7/s"))).toBe(true);
  });
});
