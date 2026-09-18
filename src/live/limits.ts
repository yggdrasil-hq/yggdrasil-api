/**
 * ADR 019 follow-up 4 / issue #24: the per-socket frame budget.
 *
 * The relay is the first surface where a *client* can influence frame volume
 * indirectly, through a third party (the model's token rate), and the first
 * long-lived connection — which changes the economics of an abusive client.
 * Nothing in the API bounds frames emitted to a socket, so this does.
 *
 * **Where the budget lives, and why.** It is attached to a connection and
 * consulted by `connection.send`, not by the hub's fan-out loop. That is the one
 * place every server→client frame passes through — stored events, deltas,
 * `pong` replies to a client's `ping`, and the handshake's own `ready` — so a
 * budget there bounds *frames emitted to a socket*, which is exactly what the
 * issue asks for. Putting it in the hub would miss `pong`, and a client can send
 * `ping` as fast as it likes, so a pong flood is the one frame rate a client
 * controls entirely. (The hub stays a pure routing structure, which is also why
 * its own tests need no clock.)
 *
 * **Token bucket, not a fixed window.** A fixed window has the classic
 * two-for-one boundary: `limit` frames at the end of one window and `limit`
 * again at the start of the next is a burst of `2 × limit` in a few
 * milliseconds, which is precisely the burst the limit exists to absorb. A
 * bucket refills continuously, so there is no boundary to straddle, and it is
 * the shape that lets a short burst through (a turn ending appends several
 * stored events at once) while still bounding the sustained rate. It is also
 * O(1) memory per connection, with no timer to clean up.
 *
 * **Why exceeding the budget closes the socket rather than dropping frames.**
 * Reasoned about against the client that ships, not in the abstract:
 *
 *  - Dropping is silent and unbounded. The server still fans out to the socket
 *    and decides to discard, so it bounds the `send` cost but not the per-frame
 *    work; and the client cannot tell a dropped frame from an idle model, so it
 *    renders a transcript with holes in it.
 *  - Closing loses nothing. The relay is an *accelerator over the REST read*
 *    (ADR 019 items 7 and 11): the Web app's poll is a complete state path, and
 *    the authoritative `agent_text` for any message arrives over it. A closed
 *    socket therefore costs the user *immediacy*, never content — the same
 *    trade-off the ADR already accepts for a lost delta, made explicit instead
 *    of accidental.
 *  - It is observable. A close code plus one log line names the condition, where
 *    a drop is invisible by construction. This codebase would rather a limit be
 *    legible than graceful.
 *
 * **Why the numbers are generous.** A single `feature_build` or `spec_grill`
 * turn streams through the Orchestrator's coalescer, which flushes every 75 ms
 * (issue #23) — so a job emits at most ~13 deltas/second, and the Web app opens
 * one socket per feature. A sustained budget of 60 frames/second is therefore
 * ~4× the busiest legitimate stream the product can produce, and the burst
 * allowance absorbs a turn boundary (where several stored events land together).
 * Tripping it means either many features multiplexed onto one socket or a
 * genuinely abusive client, and it is deliberately not tuned to the product's
 * own rate: a limit that fires during normal work would be a worse bug than the
 * gap it closes.
 *
 * **What this does not bound, stated plainly.** A socket that reconnects gets a
 * fresh bucket, so this bounds what one *connection* costs, not what one user
 * costs. Bounding a user needs a connection-count limit (many sockets, each
 * within budget) with cross-replica bookkeeping and liveness detection for a
 * socket whose peer vanished without a FIN — a different resource and a larger
 * piece of work, filed separately rather than half-built here. The per-*job*
 * ceiling in `jobs/repository.ts` is the other half of this issue and attacks
 * the producer rather than the consumer.
 */

export interface FrameBudgetOptions {
  /**
   * How many frames may be sent back-to-back before the sustained rate applies.
   * This is the "a turn just ended and several events landed at once" allowance.
   */
  burst: number;
  /** Sustained frames per second, refilled continuously. */
  perSecond: number;
  /**
   * Injected so the boundary is testable without waiting on real time. Defaults
   * to `Date.now`; nothing in production passes one.
   */
  now?: () => number;
}

/**
 * A per-connection token bucket over outbound frames.
 *
 * Values below 1 are clamped, and that clamp is load-bearing: a `burst` or rate
 * of 0 — or a `NaN` from an unparseable env var that slipped past the config's
 * own flooring — would make `take()` return false on the very first frame and
 * close every socket the instant it said `ready`. A limit that takes the relay
 * down is worse than no limit, so the floor is a self-inflicted-outage guard
 * rather than a nicety. The boundary a test needs (one frame allowed, the next
 * refused) is reachable with `burst: 1`.
 */
export class FrameBudget {
  private readonly burst: number;
  private readonly perSecond: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(options: FrameBudgetOptions) {
    this.burst = wholeFrames(options.burst);
    this.perSecond = positiveRate(options.perSecond);
    this.now = options.now ?? Date.now;
    this.tokens = this.burst;
    this.lastRefillMs = this.now();
  }

  /**
   * Consumes one frame's worth of budget, returning false when the connection
   * has none left.
   *
   * Refill is computed on demand from elapsed time rather than by a timer, so an
   * idle connection costs nothing and there is no interval to cancel when it
   * closes — and the arithmetic cannot drift, because each call measures from
   * the previous call rather than accumulating ticks.
   */
  take(): boolean {
    const at = this.now();
    const elapsedMs = at - this.lastRefillMs;
    if (elapsedMs > 0) {
      this.tokens = Math.min(
        this.burst,
        this.tokens + (elapsedMs * this.perSecond) / 1000,
      );
      this.lastRefillMs = at;
    }

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Clamps a burst size to something usable.
 *
 * `Math.max(1, Math.floor(value))` is **not** enough, and the reason is worth
 * recording: `Math.max` propagates `NaN`, so a `NaN` here would leave `tokens`
 * permanently `NaN`, `NaN < 1` would be false, and `take()` would return `true`
 * forever — silently switching the limit *off*. A guard that a bad input can
 * disable is worse than no guard, because it looks like protection. Hence the
 * explicit finiteness check rather than a `Math.max` chain.
 */
function wholeFrames(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/** Same clamp, for the sustained rate, with the same `NaN` reasoning. */
function positiveRate(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}
