import { describe, expect, it } from "vitest";
import { LiveHub, type LiveConnection } from "./hub.js";
import type { ServerFrame } from "./types.js";

function fakeConnection(
  id: string,
  options: { failOnSend?: boolean } = {},
): { connection: LiveConnection; sent: ServerFrame[] } {
  const sent: ServerFrame[] = [];
  return {
    sent,
    connection: {
      id,
      send(frame: ServerFrame) {
        if (options.failOnSend) throw new Error("socket is not open");
        sent.push(frame);
      },
    },
  };
}

const frame: ServerFrame = { type: "pong" };

describe("LiveHub", () => {
  it("delivers a published frame to every subscriber on the topic", () => {
    const hub = new LiveHub();
    const a = fakeConnection("a");
    const b = fakeConnection("b");
    hub.subscribe(a.connection, "feature:1");
    hub.subscribe(b.connection, "feature:1");

    expect(hub.publish("feature:1", frame)).toBe(2);
    expect(a.sent).toEqual([frame]);
    expect(b.sent).toEqual([frame]);
  });

  it("supports several tabs for one user as independent connections", () => {
    // Two tabs of the same user are two sockets, not one — each has its own
    // connection, and closing one must not disturb the other.
    const hub = new LiveHub();
    const tabOne = fakeConnection("user:tab1");
    const tabTwo = fakeConnection("user:tab2");
    hub.subscribe(tabOne.connection, "feature:1");
    hub.subscribe(tabTwo.connection, "feature:1");
    expect(hub.subscriberCount("feature:1")).toBe(2);

    hub.remove(tabOne.connection);
    expect(hub.subscriberCount("feature:1")).toBe(1);
    expect(hub.publish("feature:1", frame)).toBe(1);
    expect(tabTwo.sent).toEqual([frame]);
    expect(tabOne.sent).toEqual([]);
  });

  it("does not deliver across topics", () => {
    const hub = new LiveHub();
    const a = fakeConnection("a");
    hub.subscribe(a.connection, "feature:1");

    expect(hub.publish("feature:2", frame)).toBe(0);
    expect(a.sent).toEqual([]);
  });

  it("is idempotent for a repeated subscribe", () => {
    const hub = new LiveHub();
    const a = fakeConnection("a");
    hub.subscribe(a.connection, "feature:1");
    hub.subscribe(a.connection, "feature:1");

    expect(hub.subscriberCount("feature:1")).toBe(1);
    expect(hub.publish("feature:1", frame)).toBe(1);
    expect(a.sent).toHaveLength(1);
  });

  it("stops delivering after an unsubscribe and frees the topic", () => {
    const hub = new LiveHub();
    const a = fakeConnection("a");
    hub.subscribe(a.connection, "feature:1");
    hub.unsubscribe(a.connection, "feature:1");

    expect(hub.subscriberCount("feature:1")).toBe(0);
    expect(hub.publish("feature:1", frame)).toBe(0);
    expect(a.sent).toEqual([]);
  });

  it("removes a connection from every topic it was on", () => {
    const hub = new LiveHub();
    const a = fakeConnection("a");
    hub.subscribe(a.connection, "feature:1");
    hub.subscribe(a.connection, "feature:2");

    hub.remove(a.connection);
    expect(hub.subscriberCount("feature:1")).toBe(0);
    expect(hub.subscriberCount("feature:2")).toBe(0);
    expect(hub.connectionCount()).toBe(0);
  });

  it("prunes a connection whose send throws, without depriving the others", () => {
    // The failure mode this prevents: one half-closed tab making every later
    // publish throw, which would take the whole feature's relay down with it.
    const hub = new LiveHub();
    const dead = fakeConnection("dead", { failOnSend: true });
    const alive = fakeConnection("alive");
    hub.subscribe(dead.connection, "feature:1");
    hub.subscribe(alive.connection, "feature:1");

    expect(hub.publish("feature:1", frame)).toBe(1);
    expect(alive.sent).toEqual([frame]);
    expect(hub.subscriberCount("feature:1")).toBe(1);

    // And again, to prove the dead one is really gone rather than merely
    // skipped this once.
    expect(hub.publish("feature:1", frame)).toBe(1);
    expect(alive.sent).toHaveLength(2);
  });

  it("is a no-op for publish/remove on unknown topics and connections", () => {
    const hub = new LiveHub();
    const a = fakeConnection("a");
    expect(hub.publish("feature:none", frame)).toBe(0);
    expect(() => hub.remove(a.connection)).not.toThrow();
    expect(() => hub.unsubscribe(a.connection, "feature:none")).not.toThrow();
    expect(hub.connectionCount()).toBe(0);
  });

  it("tracks connection count only while a connection is subscribed", () => {
    const hub = new LiveHub();
    const a = fakeConnection("a");
    expect(hub.connectionCount()).toBe(0);
    hub.subscribe(a.connection, "feature:1");
    expect(hub.connectionCount()).toBe(1);
    hub.unsubscribe(a.connection, "feature:1");
    expect(hub.connectionCount()).toBe(0);
  });
});
