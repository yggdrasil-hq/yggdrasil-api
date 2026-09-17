import type { Queryable } from "../db/pool.js";
import { encodeDeltaPayload, LIVE_JOB_EVENT_DELTAS_CHANNEL } from "./types.js";

/**
 * The API's write side for streaming text deltas (ADR 019 item 13).
 *
 * An interface rather than a concrete class so the internal route can be tested
 * without a database, and so a deployment with the relay switched off can be
 * given the no-op below instead of a live publisher.
 */
export interface LivePublisher {
  /**
   * Relays one chunk of streaming assistant text. Best-effort by contract: a
   * caller must be able to ignore the result, because a lost delta costs a
   * moment of smoothness and never content — the authoritative `agent_text`
   * still arrives over the persisted path (see `EventAgentTextDelta` in
   * `orchestrator/internal/rpc/curated.go`).
   */
  publishDelta(delta: { featureId: string; jobId: string; text: string }): Promise<void>;
}

/** Used when the relay is disabled, and as the default in tests. */
export const NOOP_LIVE_PUBLISHER: LivePublisher = {
  async publishDelta() {
    // Deliberately empty: with no publisher configured a delta is accepted and
    // dropped, which is the same outcome a client sees when the relay is off.
  },
};

export interface DeltaPublisherOptions {
  /** Injected so a test can assert the payload without a database. */
  onError?: (message: string) => void;
  channel?: string;
}

/**
 * Publishes deltas through Postgres `NOTIFY`, exactly as stored events are
 * published, so every API replica's listener fans them out to its own sockets.
 *
 * Publishing straight to an in-process hub would be wrong, not merely
 * inelegant: sockets are held by whichever replica accepted the upgrade and the
 * Orchestrator's HTTP POST lands on whichever replica nginx picked, so with the
 * 2-replica deployment ADR 003 §20 commits to, roughly half of all deltas would
 * reach no one. That is the same failure ADR 019's alternatives table already
 * rejects for stored events ("an in-process emitter on the write path ...
 * silently relays only events written by the same API replica").
 *
 * No row is written and nothing is read back: the payload is self-contained
 * because there is no row to read (see `encodeDeltaPayload`).
 */
export class PostgresDeltaPublisher implements LivePublisher {
  constructor(
    private readonly db: Queryable,
    private readonly options: DeltaPublisherOptions = {},
  ) {}

  async publishDelta(delta: { featureId: string; jobId: string; text: string }): Promise<void> {
    const payload = encodeDeltaPayload(delta);
    if (payload === null) {
      // Either an empty field or an oversize payload. Both are bugs rather than
      // conditions to propagate — the caller is a best-effort relay path, and
      // failing the request would report an error for something no one can act
      // on. Logged so the bug is visible.
      this.report(
        `live relay: dropped a delta for job ${delta.jobId} (empty field or oversize payload)`,
      );
      return;
    }

    await this.db.query("SELECT pg_notify($1, $2)", [
      this.options.channel ?? LIVE_JOB_EVENT_DELTAS_CHANNEL,
      payload,
    ]);
  }

  private report(message: string): void {
    (this.options.onError ?? ((text: string) => console.error(text)))(message);
  }
}
