import type { ServerFrame } from "./types.js";

/**
 * The smallest thing the hub needs from a socket. Deliberately an interface
 * rather than `ws.WebSocket` so the fan-out rules — one topic to many sockets,
 * several tabs for one user, cleanup on close, a dead socket not stalling its
 * siblings — are unit-testable without opening a real port (ADR 019 item 5).
 */
export interface LiveConnection {
  readonly id: string;
  send(frame: ServerFrame): void;
}

/**
 * Routes published frames to the sockets subscribed to a topic.
 *
 * In-process only, and correctly so: every API replica needs to reach only the
 * sockets *it* holds, and the cross-replica hop is Postgres LISTEN/NOTIFY
 * (ADR 019 item 6) — each replica runs its own listener and fans out to its own
 * sockets. There is no shared bus state to keep consistent, so there is nothing
 * here to coordinate between processes.
 *
 * A topic is an opaque string (`liveTopicForFeature` is the only place one is
 * spelled) so a second topic shape cannot collide with a feature's.
 */
export class LiveHub {
  private readonly connectionsByTopic = new Map<string, Set<LiveConnection>>();
  private readonly topicsByConnection = new Map<string, Set<string>>();

  /** Idempotent: a tab that subscribes twice to one topic is still one entry. */
  subscribe(connection: LiveConnection, topic: string): void {
    let subscribers = this.connectionsByTopic.get(topic);
    if (!subscribers) {
      subscribers = new Set();
      this.connectionsByTopic.set(topic, subscribers);
    }
    subscribers.add(connection);

    let topics = this.topicsByConnection.get(connection.id);
    if (!topics) {
      topics = new Set();
      this.topicsByConnection.set(connection.id, topics);
    }
    topics.add(topic);
  }

  unsubscribe(connection: LiveConnection, topic: string): void {
    const subscribers = this.connectionsByTopic.get(topic);
    if (subscribers) {
      subscribers.delete(connection);
      if (subscribers.size === 0) this.connectionsByTopic.delete(topic);
    }
    const topics = this.topicsByConnection.get(connection.id);
    if (topics) {
      topics.delete(topic);
      if (topics.size === 0) this.topicsByConnection.delete(connection.id);
    }
  }

  /**
   * Drops a socket from every topic it was on. Called on close, so a closed tab
   * cannot be written to by a later event and is not retained for the life of
   * the process.
   */
  remove(connection: LiveConnection): void {
    const topics = this.topicsByConnection.get(connection.id);
    if (topics) {
      for (const topic of topics) {
        const subscribers = this.connectionsByTopic.get(topic);
        if (!subscribers) continue;
        subscribers.delete(connection);
        if (subscribers.size === 0) this.connectionsByTopic.delete(topic);
      }
      this.topicsByConnection.delete(connection.id);
      return;
    }
    // A connection that closed without ever subscribing has no reverse index
    // entry, but may still be reachable from a topic set only if subscribe and
    // the reverse-index write were split — they are not, so there is nothing
    // left to clean up. Kept as an explicit branch so the invariant is stated.
  }

  /**
   * Delivers `frame` to every socket on `topic` and returns how many accepted
   * it. A socket whose `send` throws is removed and the fan-out continues: one
   * dead tab (a half-closed socket, a torn-down client) must not deprive the
   * others of an event, and leaving it in the set would make every subsequent
   * publish throw again (ADR 019 item 9).
   */
  publish(topic: string, frame: ServerFrame): number {
    const subscribers = this.connectionsByTopic.get(topic);
    if (!subscribers) return 0;

    let delivered = 0;
    for (const connection of [...subscribers]) {
      try {
        connection.send(frame);
        delivered += 1;
      } catch {
        subscribers.delete(connection);
        this.topicsByConnection.delete(connection.id);
      }
    }
    if (subscribers.size === 0) this.connectionsByTopic.delete(topic);
    return delivered;
  }

  subscriberCount(topic: string): number {
    return this.connectionsByTopic.get(topic)?.size ?? 0;
  }

  connectionCount(): number {
    return this.topicsByConnection.size;
  }
}
