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
/*
 * Issue #25: a design session is a `design_grill` *job*, and its session id is the
 * job id. Two of them, because the authorisation has two conditions to satisfy —
 * the id has to resolve inside the project, *and* the job has to be the right kind.
 */
const SESSION_ID = "88888888-8888-4888-8888-888888888888";
/** In the project, but a different kind — the case the REST route also rejects. */
const NON_DESIGN_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/*
 * Issue #90: a Test entity's id, which is a `tests` row id rather than a job id.
 * Named separately from `NON_DESIGN_JOB_ID` because the test scope resolves its
 * resource through a different repository entirely.
 */
const TEST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
  /*
   * Mirrors `JobRepository.findByIdForProject` as the design-session route uses it:
   * scoped to the project, then checked for kind. The non-design id resolves *inside*
   * the project on purpose — returning null for it would pass the kind test for the
   * wrong reason, since a not-found is refused before the kind is ever read.
   */
  const jobs = {
    findByIdForProject: vi.fn(async (projectId: string, jobId: string) => {
      if (projectId !== PROJECT_ID) return null;
      if (jobId === SESSION_ID) return { id: SESSION_ID, kind: "design_grill" };
      if (jobId === NON_DESIGN_JOB_ID) return { id: NON_DESIGN_JOB_ID, kind: "feature_build" };
      return null;
    }),
  };

  const sockets = createLiveSocketServer({
    server,
    hub,
    sessions: sessions as never,
    users: users as never,
    projects: projects as never,
    features: features as never,
    jobs: jobs as never,
    // Issue #90: the test scope's authoriser resolves a `tests` row the way the
    // run-history route does. None of these cases subscribe to a test, so this
    // only has to exist and be shaped like `TestRepository.findById`.
    tests: {
      findById: vi.fn(async (projectId: string, testId: string) =>
        projectId === PROJECT_ID && testId === TEST_ID ? { id: TEST_ID } : null,
      ),
    } as never,
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

/** Issue #25: the design-session peer of `jobEventFrame`. */
function designSessionFrame(): ServerFrame {
  return {
    type: "design_session_event",
    sessionId: SESSION_ID,
    event: {
      id: "design_event_1",
      jobId: SESSION_ID,
      type: "update_design_preview",
      question: null,
      markdown: null,
      message: null,
      status: null,
      prUrl: null,
      summary: null,
      actionItems: null,
      snapshot: null,
      createdAt: "2026-09-18T10:00:00.000Z",
    },
  };
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

/**
 * Issue #90: the frame a scheduled `test_run`'s event produces. `testId` and
 * `jobId` are deliberately different values — they are two genuinely different
 * things (the surface to refresh, and the run whose event it is), and using one
 * value for both would hide a mistake that swapped them.
 */
function testRunFrame(): ServerFrame {
  return {
    type: "test_run_event",
    testId: TEST_ID,
    jobId: "job_run_1",
    event: {
      id: "test_event_1",
      jobId: "job_run_1",
      type: "test_progress",
      question: null,
      markdown: null,
      message: "2 of 5 passing",
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
describe("live socket: design-session subscriptions (issue #25)", () => {
  /**
   * Subscribes to the fixture design session over a real socket. Two frames pass
   * through the budget before this resolves (`ready` and `subscribed_design`),
   * which the frame-budget block below accounts for separately.
   */
  async function designClient(port: number, sessionId = SESSION_ID): Promise<Client> {
    const client = connect(port, GOOD_COOKIE);
    await waitFor(() => client.frames.length > 0, "ready");
    client.send({ type: "subscribe_design", projectId: PROJECT_ID, sessionId });
    await waitFor(
      () => client.frames.some((frame) => frame.type === "subscribed_design" || frame.type === "error"),
      "subscribed_design or refusal",
    );
    return client;
  }

  it("subscribes a member to a design session and receives its events", async () => {
    // The end-to-end shape, which is the one that matters: a real socket, a real
    // frame, and an event published to the design topic reaching it. The topic is
    // `design:<sessionId>` — that string is the contract a Web client has to use.
    await withRelay(async ({ port, hub }) => {
      const client = await designClient(port);

      expect(client.frames).toContainEqual({ type: "subscribed_design", sessionId: SESSION_ID });
      expect(hub.publish(`design:${SESSION_ID}`, designSessionFrame())).toBe(1);

      const frames = await settle(client);
      expect(frames).toContainEqual(designSessionFrame());
    });
  });

  it("leaves the design subscription when asked, and then delivers nothing", async () => {
    await withRelay(async ({ port, hub }) => {
      const client = await designClient(port);
      client.send({ type: "unsubscribe_design", sessionId: SESSION_ID });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "unsubscribed_design"),
        "unsubscribed_design",
      );

      // The half that makes unsubscribing mean something: the hub no longer counts
      // this connection, so the event goes nowhere.
      expect(hub.publish(`design:${SESSION_ID}`, designSessionFrame())).toBe(0);
      const frames = await settle(client);
      expect(frames.some((frame) => frame.type === "design_session_event")).toBe(false);
    });
  });

  it("refuses a design session in a project the caller is not a member of", async () => {
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");
      client.send({ type: "subscribe_design", projectId: OTHER_PROJECT_ID, sessionId: SESSION_ID });
      await waitFor(() => client.frames.some((frame) => frame.type === "error"), "refusal");

      expect(client.frames).toContainEqual({
        type: "error",
        message: "Design session not found",
      });
      expect(hub.publish(`design:${SESSION_ID}`, designSessionFrame())).toBe(0);
    });
  });

  it("refuses a job in the project that is not a design session", async () => {
    // The kind check, over a real socket. `findByIdForProject` resolves this id in
    // the project, so only the kind condition refuses it — without that condition
    // a design-session frame would be a way to watch a feature_build's events.
    await withRelay(async ({ port, hub }) => {
      const client = await designClient(port, NON_DESIGN_JOB_ID);

      expect(client.frames).toContainEqual({
        type: "error",
        message: "Design session not found",
      });
      expect(client.frames.some((frame) => frame.type === "subscribed_design")).toBe(false);
      expect(hub.publish(`design:${NON_DESIGN_JOB_ID}`, designSessionFrame())).toBe(0);
    });
  });

  it("refuses a session id that does not exist", async () => {
    await withRelay(async ({ port }) => {
      const unknown = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const client = await designClient(port, unknown);

      expect(client.frames).toContainEqual({
        type: "error",
        message: "Design session not found",
      });
    });
  });

  it("keeps the two topic families separate on one socket", async () => {
    // A feature subscription and a design subscription on the same connection,
    // then a publish to each. The two topics must not bleed into each other — the
    // reason the `design:` prefix exists, since the hub treats a topic as an
    // opaque string and the two id spaces are both uuids.
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
      await waitFor(() => client.frames.some((frame) => frame.type === "subscribed"), "subscribed");
      client.send({ type: "subscribe_design", projectId: PROJECT_ID, sessionId: SESSION_ID });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "subscribed_design"),
        "subscribed_design",
      );

      expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(1);
      // One, not two: the design topic has exactly one subscriber (this socket),
      // and the feature publish did not reach it.
      expect(hub.publish(`design:${SESSION_ID}`, designSessionFrame())).toBe(1);

      const frames = await settle(client);
      expect(frames).toContainEqual(jobEventFrame());
      expect(frames).toContainEqual(designSessionFrame());
    });
  });

  it("treats a malformed design id as a malformed frame, not a refused subscription", async () => {
    // `parseClientFrame` validates ids at the boundary, so a non-uuid never reaches
    // the authoriser: it is an *unrecognised frame*, counted against the
    // protocol-error budget like any other malformed frame. That is the contract,
    // and it is worth pinning because the two failure modes look alike from a
    // client — "my id was rejected" and "your frame was malformed" — while only
    // the second is a client bug, and only the second can close the socket.
    //
    // (`authorizeDesignSessionSubscription` has its own `isUuid` guard. From the
    // socket that guard is unreachable — parsing already refused — so it is
    // defence in depth for a direct caller, not the first line here.)
    await withRelay(async ({ port }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe_design", projectId: PROJECT_ID, sessionId: "not-a-uuid" });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "error"),
        "first protocol error",
      );

      const frames = await settle(client);
      expect(frames).toContainEqual({ type: "error", message: "Unrecognised frame" });
      // Not a `subscribed_design`, and no refusal message of its own — the frame
      // never became a subscription request at all.
      expect(frames.some((frame) => frame.type === "subscribed_design")).toBe(false);
      expect(frames.some((frame) => frame.type === "error" && "message" in frame && frame.message === "Design session not found")).toBe(false);

      // And it is a real protocol error: reaching the connection's budget closes
      // the socket with the protocol code, which a refused subscription never does.
      // The count comes from the constant so this cannot drift from the rule it is
      // asserting — my first version hard-coded three and timed out, because the
      // budget is five.
      for (let sent = 1; sent < LIVE_MAX_PROTOCOL_ERRORS; sent += 1) {
        client.send({ type: "subscribe_design", projectId: PROJECT_ID, sessionId: "still-not-a-uuid" });
      }
      await waitFor(() => client.closed() !== null, "protocol close");
      expect(client.closed()?.code).toBe(LIVE_CLOSE_PROTOCOL);
    });
  });
});

/*
 * Issue #90: the `test:` scope, driven over a real socket. The authoriser and the
 * routing are covered as units elsewhere; this is the end-to-end shape, because
 * the three things that could still be wrong here — the frame name the client
 * must send, the topic string the API publishes to, and which frame it replies
 * with — are all cross-process contracts rather than internal decisions.
 */
describe("live socket: test subscriptions (issue #90)", () => {
  async function testClient(port: number, testId = TEST_ID): Promise<Client> {
    const client = connect(port, GOOD_COOKIE);
    await waitFor(() => client.frames.length > 0, "ready");
    client.send({ type: "subscribe_test", projectId: PROJECT_ID, testId });
    await waitFor(
      () => client.frames.some((frame) => frame.type === "subscribed_test" || frame.type === "error"),
      "subscribed_test or refusal",
    );
    return client;
  }

  it("subscribes a member to a test and receives its scheduled run's events", async () => {
    // The whole point of the issue: a scheduled `test_run` has no feature, so its
    // events had no topic and reached no socket. This is that path end to end.
    await withRelay(async ({ port, hub }) => {
      const client = await testClient(port);

      expect(client.frames).toContainEqual({ type: "subscribed_test", testId: TEST_ID });
      // `test:<testId>` is the string contract — a Web client has to build it.
      expect(hub.publish(`test:${TEST_ID}`, testRunFrame())).toBe(1);

      const frames = await settle(client);
      expect(frames).toContainEqual(testRunFrame());
    });
  });

  it("leaves the test subscription when asked, and then delivers nothing", async () => {
    await withRelay(async ({ port, hub }) => {
      const client = await testClient(port);
      client.send({ type: "unsubscribe_test", testId: TEST_ID });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "unsubscribed_test"),
        "unsubscribed_test",
      );

      // The half that makes unsubscribing mean something: the hub no longer counts
      // this connection, so a later run event goes nowhere.
      expect(hub.publish(`test:${TEST_ID}`, testRunFrame())).toBe(0);
      const frames = await settle(client);
      expect(frames.some((frame) => frame.type === "test_run_event")).toBe(false);
    });
  });

  it("refuses a test in a project the caller is not a member of", async () => {
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");
      client.send({ type: "subscribe_test", projectId: OTHER_PROJECT_ID, testId: TEST_ID });
      await waitFor(() => client.frames.some((frame) => frame.type === "error"), "refusal");

      expect(client.frames).toContainEqual({ type: "error", message: "Test not found" });
      expect(hub.publish(`test:${TEST_ID}`, testRunFrame())).toBe(0);
    });
  });

  it("refuses a test id that is not in the project", async () => {
    await withRelay(async ({ port, hub }) => {
      const unknown = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      const client = await testClient(port, unknown);

      expect(client.frames).toContainEqual({ type: "error", message: "Test not found" });
      expect(client.frames.some((frame) => frame.type === "subscribed_test")).toBe(false);
      expect(hub.publish(`test:${unknown}`, testRunFrame())).toBe(0);
    });
  });

  it("keeps the test topic separate from the feature and design ones", async () => {
    // Three scopes on one socket. All three id spaces are uuids, so only the topic
    // prefix keeps them apart — the reason each scope has its own. A publish to one
    // must reach exactly one subscriber and appear as exactly one frame type.
    await withRelay(async ({ port, hub }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
      await waitFor(() => client.frames.some((frame) => frame.type === "subscribed"), "subscribed");
      client.send({ type: "subscribe_design", projectId: PROJECT_ID, sessionId: SESSION_ID });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "subscribed_design"),
        "subscribed_design",
      );
      client.send({ type: "subscribe_test", projectId: PROJECT_ID, testId: TEST_ID });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "subscribed_test"),
        "subscribed_test",
      );

      expect(hub.publish(`feature:${FEATURE_ID}`, jobEventFrame())).toBe(1);
      expect(hub.publish(`design:${SESSION_ID}`, designSessionFrame())).toBe(1);
      expect(hub.publish(`test:${TEST_ID}`, testRunFrame())).toBe(1);

      const frames = await settle(client);
      expect(frames).toContainEqual(jobEventFrame());
      expect(frames).toContainEqual(designSessionFrame());
      expect(frames).toContainEqual(testRunFrame());
    });
  });

  it("treats a malformed test id as a malformed frame, not a refused subscription", async () => {
    // Same contract as the design path, and worth pinning for the same reason: a
    // non-uuid never reaches the authoriser, so it is an *unrecognised frame*
    // counted against the protocol-error budget, not a "Test not found" refusal.
    // The two look alike to a client while only one is a client bug.
    await withRelay(async ({ port }) => {
      const client = connect(port, GOOD_COOKIE);
      await waitFor(() => client.frames.length > 0, "ready");

      client.send({ type: "subscribe_test", projectId: PROJECT_ID, testId: "not-a-uuid" });
      await waitFor(
        () => client.frames.some((frame) => frame.type === "error"),
        "first protocol error",
      );

      const frames = await settle(client);
      expect(frames).toContainEqual({ type: "error", message: "Unrecognised frame" });
      expect(frames.some((frame) => frame.type === "subscribed_test")).toBe(false);
      expect(
        frames.some(
          (frame) => frame.type === "error" && "message" in frame && frame.message === "Test not found",
        ),
      ).toBe(false);
    });
  });
});

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
