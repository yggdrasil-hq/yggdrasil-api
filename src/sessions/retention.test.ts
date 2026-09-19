import { describe, expect, it } from "vitest";
import {
  isSessionOutcome,
  permitsFork,
  rejectSessionUpload,
  sessionState,
  SESSION_OUTCOMES,
  UNKNOWN_SESSION_STATE,
  type SessionState,
} from "./retention.js";

const NOW = new Date("2026-09-19T12:00:00.000Z");
const FUTURE = new Date("2026-10-19T12:00:00.000Z");
const PAST = new Date("2026-09-01T12:00:00.000Z");

function stateOf(
  outcome: "collected" | "not_collected" | "unavailable",
  extra: { hasData?: boolean; expiresAt?: Date | null; purgedAt?: Date | null } = {},
): SessionState {
  return sessionState(
    {
      outcome,
      hasData: extra.hasData ?? true,
      expiresAt: extra.expiresAt === undefined ? FUTURE : extra.expiresAt,
      purgedAt: extra.purgedAt ?? null,
    },
    NOW,
  );
}

describe("sessionState", () => {
  it("is available for a collected session within its window", () => {
    expect(stateOf("collected")).toBe("available");
  });

  it("is expired once the window has passed", () => {
    expect(stateOf("collected", { expiresAt: PAST })).toBe("expired");
  });

  it("is expired for a tombstone even with a future expiry", () => {
    // The bytes are what the caller came for, so a reclaimed artifact is expired
    // whatever its clock says — `expiresAt <= now` is the normal route to this
    // state, not the only one.
    expect(stateOf("collected", { hasData: false, purgedAt: NOW })).toBe("expired");
  });

  /**
   * The whole of ADR 032 item 5 in one test. These two are the states a
   * three-state artifact model collapses, and collapsing them makes a transient
   * upload failure indistinguishable from a run that never got far enough to have
   * a session — the "looks finished, does nothing" shape this suite keeps finding.
   */
  it("keeps not_collected and unavailable apart, though both have no bytes", () => {
    const notCollected = sessionState(
      { outcome: "not_collected", hasData: false, expiresAt: null, purgedAt: null },
      NOW,
    );
    const unavailable = sessionState(
      { outcome: "unavailable", hasData: false, expiresAt: null, purgedAt: null },
      NOW,
    );

    expect(notCollected).toBe("not_collected");
    expect(unavailable).toBe("unavailable");
    expect(notCollected).not.toBe(unavailable);
  });

  it("consults the outcome before the bytes, so a failing outcome can never read as available", () => {
    // Unwritable through the route and rejected by the table's CHECK, and stated
    // as a property anyway: this must stay honest if either is ever relaxed.
    expect(stateOf("not_collected", { hasData: true })).toBe("not_collected");
    expect(stateOf("unavailable", { hasData: true })).toBe("unavailable");
  });

  it("has a fifth state for 'no row', distinct from not_collected", () => {
    // No row is "this API was never told", which is what an install with
    // collection switched off produces. `not_collected` is the Orchestrator
    // reporting that Pi answered and produced nothing — a different claim, and the
    // UI must not describe the first as the run's fault.
    expect(UNKNOWN_SESSION_STATE).toBe("unknown");
    expect(UNKNOWN_SESSION_STATE).not.toBe("not_collected");
  });
});

describe("permitsFork", () => {
  it("permits a fork only for an available session", () => {
    const states: SessionState[] = [
      "available",
      "expired",
      "not_collected",
      "unavailable",
      "unknown",
    ];
    expect(states.filter(permitsFork)).toEqual(["available"]);
  });
});

describe("isSessionOutcome", () => {
  it("accepts exactly the three posted outcomes", () => {
    expect(SESSION_OUTCOMES).toEqual(["collected", "not_collected", "unavailable"]);
    for (const outcome of SESSION_OUTCOMES) expect(isSessionOutcome(outcome)).toBe(true);
  });

  it("rejects disabled, which the Orchestrator never posts", () => {
    // A fact about the installation rather than the run: a switched-off deployment
    // writes no per-run row, so it must not be storable as one either.
    expect(isSessionOutcome("disabled")).toBe(false);
  });

  it("rejects anything unrecognised rather than coercing it", () => {
    for (const value of ["", "Collected", "collected ", "nope"]) {
      expect(isSessionOutcome(value)).toBe(false);
    }
  });
});

describe("rejectSessionUpload", () => {
  const maxBytes = 5_000_000;

  it("accepts a collected session inside the cap", () => {
    expect(
      rejectSessionUpload({ outcome: "collected", byteSize: 1024, maxBytes }),
    ).toBeNull();
  });

  it("accepts a collected session of exactly the cap", () => {
    // Inclusive upper bound, matching `exceedsSizeCap`: the number reads as "the
    // largest session you may store", not "one byte less than you'd expect".
    expect(
      rejectSessionUpload({ outcome: "collected", byteSize: maxBytes, maxBytes }),
    ).toBeNull();
  });

  it("refuses a collected session one byte over the cap, naming both sizes", () => {
    const reason = rejectSessionUpload({
      outcome: "collected",
      byteSize: maxBytes + 1,
      maxBytes,
    });
    expect(reason).toBe("Session exceeds the 5.0 MB limit (5.0 MB)");
  });

  /**
   * The outcome has to agree with the body. The table's CHECK constrains one row
   * and cannot see a contradiction between two of its columns, so this is the only
   * place it can be caught.
   */
  it("refuses a collected outcome with no body", () => {
    expect(
      rejectSessionUpload({ outcome: "collected", byteSize: 0, maxBytes }),
    ).toContain("empty body");
  });

  it("refuses a failing outcome that carries a body", () => {
    for (const outcome of ["not_collected", "unavailable"] as const) {
      expect(rejectSessionUpload({ outcome, byteSize: 10, maxBytes })).toContain(
        outcome,
      );
    }
  });

  it("accepts a failing outcome with an empty body", () => {
    for (const outcome of ["not_collected", "unavailable"] as const) {
      expect(rejectSessionUpload({ outcome, byteSize: 0, maxBytes })).toBeNull();
    }
  });

  /**
   * ADR 032 item 4: a cap of zero is the instruction "reclaim everything", not
   * "keep forever" and not "no limit". So it refuses every upload — and its reason
   * says the policy rather than claiming an artifact was too big.
   */
  it("refuses every upload when the cap is zero, and says so", () => {
    expect(rejectSessionUpload({ outcome: "collected", byteSize: 0, maxBytes: 0 })).toBe(
      "Session collection is switched off",
    );
    expect(
      rejectSessionUpload({ outcome: "collected", byteSize: 1, maxBytes: 0 }),
    ).toBe("Session collection is switched off");
    expect(
      rejectSessionUpload({ outcome: "not_collected", byteSize: 0, maxBytes: 0 }),
    ).toBe("Session collection is switched off");
  });
});
