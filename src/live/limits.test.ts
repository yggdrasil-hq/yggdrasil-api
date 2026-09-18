import { describe, expect, it } from "vitest";
import { FrameBudget } from "./limits.js";

/**
 * Issue #24. A controllable clock is what makes these assertions about the
 * boundary rather than about how fast the test machine is — the rate is the
 * whole subject, so `setTimeout`-based tests would be both slow and flaky.
 */
function clock() {
  let nowMs = 1_000_000;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("FrameBudget", () => {
  it("allows a burst of exactly the burst size, then refuses", () => {
    // The boundary, stated as three cases: the last permitted frame is allowed,
    // the next is not, and the count either side of it is exact.
    const budget = new FrameBudget({ burst: 3, perSecond: 1, now: () => 0 });

    expect(budget.take()).toBe(true); // 1
    expect(budget.take()).toBe(true); // 2
    expect(budget.take()).toBe(true); // 3 — at the limit
    expect(budget.take()).toBe(false); // over
    expect(budget.take()).toBe(false); // and still over
  });

  it("refills continuously at the sustained rate", () => {
    const time = clock();
    const budget = new FrameBudget({ burst: 2, perSecond: 10, now: time.now });

    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);

    // 10/s means one token per 100ms. Just under, still refused...
    time.advance(99);
    expect(budget.take()).toBe(false);
    // ...and at exactly 100ms, one token is available.
    time.advance(1);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it("never accumulates more than the burst, however long it idles", () => {
    // The property that bounds a burst after a pause. Without the cap, a socket
    // left idle for an hour would be entitled to 3600s × rate frames at once —
    // the fixed-window boundary problem in a different costume.
    const time = clock();
    const budget = new FrameBudget({ burst: 4, perSecond: 10, now: time.now });

    expect(budget.take()).toBe(true); // 3 left

    time.advance(60 * 60 * 1000);

    for (let served = 0; served < 4; served += 1) {
      expect(budget.take(), `frame ${served + 1}`).toBe(true);
    }
    expect(budget.take()).toBe(false);
  });

  it("refills fractionally rather than in whole frames", () => {
    // A burst allowance must not round each partial refill away, or a slow
    // stream would starve: two 50ms intervals at 10/s have to add up to one
    // token, not to zero twice.
    const time = clock();
    const budget = new FrameBudget({ burst: 1, perSecond: 10, now: time.now });

    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);

    time.advance(50);
    expect(budget.take()).toBe(false);
    time.advance(50);
    expect(budget.take()).toBe(true);
  });

  it("tolerates a clock that does not advance", () => {
    // Date.now has millisecond resolution, so a burst of frames inside one
    // millisecond sees zero elapsed time. That must mean "no refill", not a
    // negative or infinite one.
    const budget = new FrameBudget({ burst: 2, perSecond: 60, now: () => 5 });

    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
  });

  it("tolerates a clock that goes backwards", () => {
    // NTP steps the wall clock back. A negative elapsed time must not *remove*
    // tokens (which would close a healthy socket) — the refill is simply
    // skipped and the current balance stands.
    let nowMs = 10_000;
    const budget = new FrameBudget({ burst: 2, perSecond: 10, now: () => nowMs });

    expect(budget.take()).toBe(true); // 1 left
    nowMs -= 5_000;
    expect(budget.take()).toBe(true); // 0 left — unchanged by the backstep
    expect(budget.take()).toBe(false);
  });

  it("bottoms out at one frame instead of taking the relay down", () => {
    // A guard that closes every socket on its first frame (`ready`) would be an
    // outage caused by the protection. Zero, negative and NaN all clamp to the
    // smallest usable budget — reachable boundary, still functional.
    for (const bad of [0, -10, Number.NaN]) {
      const budget = new FrameBudget({ burst: bad, perSecond: bad, now: () => 0 });
      expect(budget.take(), `burst ${bad}`).toBe(true);
      expect(budget.take(), `burst ${bad} second`).toBe(false);
    }
  });

  it("holds the configured sustained rate over a simulated stream", () => {
    // The end-to-end shape. Over 10 seconds a socket is entitled to the initial
    // burst plus ten seconds of refill — and emphatically not to the demand,
    // which is what makes this a limit rather than a formality.
    const time = clock();
    const budget = new FrameBudget({ burst: 120, perSecond: 60, now: time.now });

    const demand = 10_000; // one frame per millisecond for ten seconds
    let served = 0;
    for (let tick = 0; tick < demand; tick += 1) {
      time.advance(1);
      if (budget.take()) served += 1;
    }

    // 60/s over 10s, plus the initial 120-frame burst, is 720. Generous bounds
    // around that, because the exact figure depends on refill rounding — but the
    // two things being asserted are unambiguous: it is nowhere near the demand,
    // and it is nowhere near zero (a limit tight enough to break normal work).
    expect(served).toBeLessThan(1_000);
    expect(served).toBeGreaterThan(600);
    expect(served).toBeLessThan(demand / 10);
  });

  it("passes a normal 75ms-coalesced stream untouched", () => {
    // The other half of "the default must not break real work": the busiest
    // legitimate stream the product can produce is ~13 deltas/s (the
    // Orchestrator's coalescer flushes every 75ms, issue #23), and it must run
    // for minutes without the budget ever being the thing that stops it.
    const time = clock();
    const budget = new FrameBudget({ burst: 120, perSecond: 60, now: time.now });

    for (let frame = 0; frame < 13 * 300; frame += 1) {
      time.advance(75); // 75ms between frames, as the coalescer emits them
      expect(budget.take(), `frame ${frame}`).toBe(true);
    }
  });

  it("gives each connection an independent budget", () => {
    // The limit is per socket. One socket exhausting its budget must not affect
    // another's, which is the whole reason `socket.ts` constructs an instance
    // per connection rather than sharing one.
    const options = { burst: 1, perSecond: 1, now: () => 0 };
    const first = new FrameBudget(options);
    const second = new FrameBudget(options);

    expect(first.take()).toBe(true);
    expect(first.take()).toBe(false);
    expect(second.take()).toBe(true);
  });
});
