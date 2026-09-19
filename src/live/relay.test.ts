import { describe, expect, it, vi } from "vitest";
import { LiveHub } from "./hub.js";
import {
  LIVE_JOB_EVENTS_CHANNEL,
  LIVE_RELAY_RETRY_MS,
  relayEnvelopeFor,
  startLiveRelay,
  type LiveListenerClient,
} from "./relay.js";
import type { JobEventWithScope } from "../jobs/events-repository.js";
import { LIVE_JOB_EVENT_DELTAS_CHANNEL, type ServerFrame } from "./types.js";

const FEATURE_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";

function scope(overrides: Partial<JobEventWithScope> = {}): JobEventWithScope {
  return {
    projectId: PROJECT_ID,
    featureId: FEATURE_ID,
    event: {
      id: EVENT_ID,
      jobId: "job_1",
      type: "agent_text",
      question: null,
      markdown: null,
      message: "hello",
      status: null,
      prUrl: null,
      summary: null,
      verdict: null,
      questionForm: null,
      actionItems: null,
      snapshot: null,
      createdAt: new Date("2026-09-18T10:00:00.000Z"),
    },
    ...overrides,
  };
}

function fakeClient() {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const connect = vi.fn(async () => undefined);
  const query = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const client: LiveListenerClient = {
    connect,
    query,
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return client;
    }),
    end,
  };
  return {
    client,
    connect,
    query,
    end,
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    listenerCount(event: string) {
      return (listeners.get(event) ?? []).length;
    },
  };
}

/** Lets the relay's `void deliver(...)` microtasks settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function build(options: { findByIdWithScope?: (...args: any[]) => any } = {}) {
  const fake = fakeClient();
  const hub = new LiveHub();
  const received: ServerFrame[] = [];
  hub.subscribe(
    { id: "conn_1", send: (frame) => received.push(frame) },
    `feature:${FEATURE_ID}`,
  );

  const findByIdWithScope =
    options.findByIdWithScope ?? vi.fn(async () => scope());
  const onError = vi.fn();
  const scheduled: Array<{ run: () => void; delayMs: number }> = [];
  const cancelled: unknown[] = [];

  const handle = startLiveRelay({
    clientFactory: () => fake.client,
    hub,
    jobEvents: { findByIdWithScope } as never,
    onError,
    scheduleRetry: (run, delayMs) => {
      scheduled.push({ run, delayMs });
      return scheduled.length;
    },
    cancelRetry: (pending) => cancelled.push(pending),
  });

  return { fake, hub, received, findByIdWithScope, onError, scheduled, cancelled, handle };
}

describe("relayEnvelopeFor", () => {
  it("routes an event to its feature's topic with the wire shape", () => {
    const envelope = relayEnvelopeFor(scope());
    expect(envelope?.topic).toBe(`feature:${FEATURE_ID}`);
    expect(envelope?.frame).toEqual({
      type: "job_event",
      featureId: FEATURE_ID,
      jobId: "job_1",
      event: expect.objectContaining({
        id: EVENT_ID,
        type: "agent_text",
        createdAt: "2026-09-18T10:00:00.000Z",
      }),
    });
  });

  it("returns null for a job that belongs to no feature", () => {
    // ADR 014's `design_grill` is project-scoped: its jobs carry no feature_id,
    // so there is no feature topic to route by. Dropping it is correct rather
    // than a gap — a design session surface would need its own topic shape.
    expect(relayEnvelopeFor(scope({ featureId: null }))).toBeNull();
  });
});

describe("startLiveRelay: deltas", () => {
  it("publishes a delta to its feature's subscribers without a database read", async () => {
    // The delta path's reason for existing: one frame per chunk, with no row and
    // no lookup.
    const { fake, received, findByIdWithScope } = build();
    await flush();

    fake.emit("notification", {
      channel: LIVE_JOB_EVENT_DELTAS_CHANNEL,
      payload: JSON.stringify({ featureId: FEATURE_ID, jobId: "job_1", text: "Hello " }),
    });
    await flush();

    expect(received).toEqual([
      { type: "job_event_delta", featureId: FEATURE_ID, jobId: "job_1", text: "Hello " },
    ]);
    expect(findByIdWithScope).not.toHaveBeenCalled();
  });

  it("preserves delta order", async () => {
    // Ordering is the one thing a client cannot repair: it concatenates these.
    const { fake, received } = build();
    await flush();

    for (const text of ["Drafting ", "the ", "ADR."]) {
      fake.emit("notification", {
        channel: LIVE_JOB_EVENT_DELTAS_CHANNEL,
        payload: JSON.stringify({ featureId: FEATURE_ID, jobId: "job_1", text }),
      });
    }
    await flush();

    expect(received.map((frame) => (frame as { text: string }).text)).toEqual([
      "Drafting ",
      "the ",
      "ADR.",
    ]);
  });

  it("keeps the two channels separate", async () => {
    // A stored event's payload is an id and would parse as nothing on the delta
    // path; a delta payload sent down the events channel is looked up as an id
    // and, finding no such row, yields nothing. Neither may be mistaken for the
    // other. The fake resolves only the real event id, like the repository would.
    const { fake, received, findByIdWithScope } = build({
      findByIdWithScope: vi.fn(async (id: string) => (id === EVENT_ID ? scope() : null)),
    });
    await flush();

    const deltaPayload = JSON.stringify({ featureId: FEATURE_ID, jobId: "job_1", text: "x" });

    fake.emit("notification", { channel: LIVE_JOB_EVENT_DELTAS_CHANNEL, payload: EVENT_ID });
    fake.emit("notification", { channel: LIVE_JOB_EVENTS_CHANNEL, payload: deltaPayload });
    await flush();

    expect(received).toEqual([]);
    // The events channel attempted exactly one read-back, and it read the delta
    // payload as though it were an event id — which is precisely the mistake the
    // channel check exists to prevent. The delta channel did not read at all.
    expect(findByIdWithScope).toHaveBeenCalledTimes(1);
    expect(findByIdWithScope).toHaveBeenCalledWith(deltaPayload);
  });

  it("drops a malformed delta without disturbing the listener", async () => {
    const { fake, received, onError, handle } = build();
    await flush();

    fake.emit("notification", { channel: LIVE_JOB_EVENT_DELTAS_CHANNEL, payload: "not json" });
    fake.emit("notification", { channel: LIVE_JOB_EVENT_DELTAS_CHANNEL, payload: "{}" });
    fake.emit("notification", {
      channel: LIVE_JOB_EVENT_DELTAS_CHANNEL,
      payload: JSON.stringify({ featureId: FEATURE_ID, jobId: "job_1", text: "" }),
    });
    await flush();

    expect(received).toEqual([]);
    // Dropped quietly: an ephemeral frame is not worth an error line, still less
    // a reconnect.
    expect(onError).not.toHaveBeenCalled();
    expect(fake.end).not.toHaveBeenCalled();
    await handle.stop();
  });

  it("routes a delta by feature, so a later job of the same feature still reaches subscribers", async () => {
    const { fake, received } = build();
    await flush();

    fake.emit("notification", {
      channel: LIVE_JOB_EVENT_DELTAS_CHANNEL,
      payload: JSON.stringify({ featureId: FEATURE_ID, jobId: "job_2", text: "retry text" }),
    });
    await flush();

    expect(received).toEqual([
      { type: "job_event_delta", featureId: FEATURE_ID, jobId: "job_2", text: "retry text" },
    ]);
  });

  it("does not deliver a delta after stop", async () => {
    const { fake, received, handle } = build();
    await flush();
    await handle.stop();

    fake.emit("notification", {
      channel: LIVE_JOB_EVENT_DELTAS_CHANNEL,
      payload: JSON.stringify({ featureId: FEATURE_ID, jobId: "job_1", text: "late" }),
    });
    await flush();

    expect(received).toEqual([]);
  });
});

describe("startLiveRelay", () => {
  it("opens a dedicated connection and subscribes to both channels", async () => {
    const { fake } = build();
    await flush();

    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.query).toHaveBeenCalledWith(`LISTEN ${LIVE_JOB_EVENTS_CHANNEL}`);
    // Deltas ride their own channel — their payload is self-contained, so unlike
    // a stored event there is no row to read back — but share the connection:
    // LISTEN is connection-scoped state, so a second channel is free.
    expect(fake.query).toHaveBeenCalledWith(`LISTEN ${LIVE_JOB_EVENT_DELTAS_CHANNEL}`);
  });

  it("delivers a notified event to the feature's subscribers", async () => {
    const { fake, received, findByIdWithScope } = build();
    await flush();

    // The payload is the event id, not the event: NOTIFY caps at 8000 bytes and
    // events carry large markdown/snapshots, so the listener reads the row.
    fake.emit("notification", { channel: LIVE_JOB_EVENTS_CHANNEL, payload: EVENT_ID });
    await flush();

    expect(findByIdWithScope).toHaveBeenCalledWith(EVENT_ID);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "job_event", featureId: FEATURE_ID });
  });

  it("ignores notifications on other channels and empty payloads", async () => {
    const { fake, received, findByIdWithScope } = build();
    await flush();

    fake.emit("notification", { channel: "job_replies", payload: EVENT_ID });
    fake.emit("notification", { channel: LIVE_JOB_EVENTS_CHANNEL, payload: "" });
    fake.emit("notification", { channel: LIVE_JOB_EVENTS_CHANNEL });
    await flush();

    expect(findByIdWithScope).not.toHaveBeenCalled();
    expect(received).toEqual([]);
  });

  it("delivers nothing when the row is gone or the job has no feature", async () => {
    const missing = build({ findByIdWithScope: vi.fn(async () => null) });
    missing.fake.emit("notification", { channel: LIVE_JOB_EVENTS_CHANNEL, payload: EVENT_ID });
    await flush();
    expect(missing.received).toEqual([]);

    const noFeature = build({
      findByIdWithScope: vi.fn(async () => scope({ featureId: null })),
    });
    noFeature.fake.emit("notification", { channel: LIVE_JOB_EVENTS_CHANNEL, payload: EVENT_ID });
    await flush();
    expect(noFeature.received).toEqual([]);
  });

  it("survives a failing delivery instead of tearing the listener down", async () => {
    // A gap in a live view is not a reason to lose the socket path: the event is
    // already durable and the poll fallback still surfaces it.
    const { fake, onError, handle, received } = build({
      findByIdWithScope: vi.fn(async () => {
        throw new Error("db unavailable");
      }),
    });
    await flush();

    fake.emit("notification", { channel: LIVE_JOB_EVENTS_CHANNEL, payload: EVENT_ID });
    await flush();

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("failed to deliver event"));
    expect(received).toEqual([]);
    // Still listening — the listener was not ended by the failure.
    expect(fake.end).not.toHaveBeenCalled();
    await handle.stop();
  });

  it("reconnects after the listener errors", async () => {
    const { fake, scheduled, onError } = build();
    await flush();

    fake.emit("error", new Error("connection reset"));
    await flush();

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("listener error"));
    expect(fake.end).toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(LIVE_RELAY_RETRY_MS);
  });

  it("reconnects after the listener ends, so it cannot silently go quiet", async () => {
    // The failure this covers: without an 'end' handler the socket client would
    // stay connected and look healthy while receiving nothing.
    const { fake, scheduled } = build();
    await flush();

    fake.emit("end");

    expect(scheduled).toHaveLength(1);
  });

  it("retries on the injected scheduler, creating a fresh connection", async () => {
    const listeners: Array<LiveListenerClient> = [];
    const fakes: ReturnType<typeof fakeClient>[] = [];
    const hub = new LiveHub();
    const scheduled: Array<() => void> = [];

    const handle = startLiveRelay({
      clientFactory: () => {
        const built = fakeClient();
        fakes.push(built);
        listeners.push(built.client);
        return built.client;
      },
      hub,
      jobEvents: { findByIdWithScope: vi.fn(async () => scope()) } as never,
      scheduleRetry: (run) => {
        scheduled.push(run);
        return scheduled.length;
      },
      cancelRetry: () => {},
    });
    await flush();
    expect(fakes).toHaveLength(1);

    fakes[0].emit("end");
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await flush();

    expect(fakes).toHaveLength(2);
    expect(fakes[1].connect).toHaveBeenCalled();
    await handle.stop();
  });

  it("stops cleanly and cancels a pending retry", async () => {
    const { fake, scheduled, cancelled, handle } = build();
    await flush();

    fake.emit("end");
    expect(scheduled).toHaveLength(1);

    await handle.stop();
    expect(fake.end).toHaveBeenCalled();
    expect(cancelled).toHaveLength(1);

    // The cancelled retry must not resurrect the listener.
    const before = fake.connect.mock.calls.length;
    await flush();
    expect(fake.connect.mock.calls.length).toBe(before);
  });

  it("is idempotent on repeated stop", async () => {
    const { fake, handle } = build();
    await flush();
    await handle.stop();
    await handle.stop();
    expect(fake.end).toHaveBeenCalledTimes(1);
  });

  it("does not deliver after stop", async () => {
    const { fake, received, handle } = build();
    await flush();
    await handle.stop();

    fake.emit("notification", { channel: LIVE_JOB_EVENTS_CHANNEL, payload: EVENT_ID });
    await flush();

    expect(received).toEqual([]);
  });

  it("reports and retries when the initial connection fails", async () => {
    const fake = fakeClient();
    fake.connect.mockRejectedValueOnce(
      new Error("ECONNREFUSED"),
    );
    const onError = vi.fn();
    const scheduled: Array<() => void> = [];

    const handle = startLiveRelay({
      clientFactory: () => fake.client,
      hub: new LiveHub(),
      jobEvents: { findByIdWithScope: vi.fn(async () => scope()) } as never,
      onError,
      scheduleRetry: (run) => {
        scheduled.push(run);
        return scheduled.length;
      },
      cancelRetry: () => {},
    });
    await flush();

    expect(onError).toHaveBeenCalledWith(expect.stringContaining("failed to establish listener"));
    expect(scheduled).toHaveLength(1);
    await handle.stop();
  });
});
