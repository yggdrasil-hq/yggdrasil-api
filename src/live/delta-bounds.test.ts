import { describe, expect, it } from "vitest";
import {
  LIVE_DELTA_MAX_PAYLOAD_BYTES,
  deltaPayloadBytes,
  deltaTextFitsPayload,
  encodeDeltaPayload,
} from "./types.js";

/**
 * Issue #78: the ingest route bounded delta text in **characters** while the
 * publisher bounded the serialised payload in **bytes**, so multi-byte text was
 * accepted by the route and then dropped by the publisher — with the producer
 * told nothing, because deltas are best-effort by design.
 *
 * The fix makes the route ask the publisher's own question, so the two cannot
 * disagree. These tests pin the property that matters, which is not "the numbers
 * match" but:
 *
 *   **anything the route accepts, the publisher accepts.**
 *
 * That is a one-directional implication, deliberately: the publisher rejecting
 * something the route also rejects is correct behaviour, not a gap. Only the
 * reverse — accepting what will be dropped — is the bug.
 *
 * The ids here are the shape the real system generates, so the measured envelope
 * is byte-identical to production's. That is what makes `deltaPayloadBytes` exact
 * rather than approximate, and it is why the placeholder approach works at all.
 */

const FEATURE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

/** The route's decision and the publisher's, for one text. */
function bothAccept(text: string): { route: boolean; publisher: boolean } {
  return {
    route: deltaTextFitsPayload(text),
    publisher: encodeDeltaPayload({ featureId: FEATURE_ID, jobId: JOB_ID, text }) !== null,
  };
}

describe("delta payload bound: the route cannot accept what the publisher drops (#78)", () => {
  /**
   * The cases that motivated the fix, plus the ones that broke the *first* fix.
   *
   * The first attempt bounded raw text bytes against a constant "envelope
   * overhead" of 109 bytes. That is wrong because `JSON.stringify` **escapes**
   * characters: 6891 newlines serialise to 13891 bytes, not 7000, so the route
   * accepted a payload twice the ceiling. These cases are here because they are
   * exactly what a plausible-looking approximation gets wrong.
   */
  const cases: Array<[string, string]> = [
    ["ASCII at the ceiling", "a".repeat(6891)],
    ["ASCII just over", "a".repeat(6892)],
    ["CJK at the ceiling", "字".repeat(2297)],
    ["emoji at the ceiling", "🙂".repeat(1722)],
    ["newlines (each escapes to two bytes)", "\n".repeat(6891)],
    ["double quotes (escaped)", '"'.repeat(6891)],
    ["backslashes (escaped)", "\\".repeat(6891)],
    ["tabs (escaped)", "\t".repeat(6891)],
    ["a mix of escapable characters", '\n"\\'.repeat(2000)],
    ["one character", "a"],
    ["far over the ceiling", "x".repeat(50_000)],
    ["a realistic streaming chunk", "The agent is now editing the Helm chart. "],
  ];

  for (const [name, text] of cases) {
    it(`agrees for ${name}`, () => {
      const { route, publisher } = bothAccept(text);
      // The invariant, stated as the implication rather than as equality.
      if (route) expect(publisher, `${name}: route accepted, publisher dropped`).toBe(true);
    });
  }

  it("rejects a multi-byte payload that the old character bound admitted", () => {
    // 4000 characters — exactly what `z.string().max(4_000)` allowed — of
    // three-byte text. The old route accepted this and the publisher dropped it.
    const text = "字".repeat(4_000);

    expect(Buffer.byteLength(text)).toBe(12_000);
    expect(deltaPayloadBytes(text)).toBeGreaterThan(LIVE_DELTA_MAX_PAYLOAD_BYTES);
    expect(bothAccept(text)).toEqual({ route: false, publisher: false });
  });

  it("still accepts a long ASCII payload that fits, so the fix is not just a smaller cap", () => {
    // The fix must not swing the other way and start rejecting text the publisher
    // would happily send — that would trade a silent drop for a 400 the producer
    // cannot act on.
    const text = "a".repeat(6_000);

    expect(bothAccept(text)).toEqual({ route: true, publisher: true });
  });
});

describe("deltaPayloadBytes is the publisher's own measurement (#78)", () => {
  it("measures exactly what the real payload serialises to", () => {
    // The property that makes the route's decision exact: substituting
    // same-shaped placeholder ids gives a byte-identical envelope, because uuids
    // are fixed width. If that ever stops holding, the route's bound silently
    // becomes an approximation again — so it is asserted rather than assumed.
    for (const text of ["", "a", "字".repeat(100), "\n".repeat(100), '"'.repeat(100)]) {
      const real = Buffer.byteLength(
        JSON.stringify({ featureId: FEATURE_ID, jobId: JOB_ID, text }),
      );
      expect(deltaPayloadBytes(text)).toBe(real);
    }
  });

  it("counts escaped characters as the serialiser will", () => {
    // The reason a constant envelope was wrong: these are 1 byte of text and 2
    // bytes of JSON each.
    const newlines = deltaPayloadBytes("\n".repeat(10));
    const plain = deltaPayloadBytes("a".repeat(10));
    expect(newlines - plain).toBe(10);
  });

  it("agrees with the ceiling at the exact boundary", () => {
    // Find the largest ASCII text that fits, and confirm the neighbour does not.
    let fit = 0;
    for (let n = 0; n < 8_000; n += 1) {
      if (deltaTextFitsPayload("a".repeat(n))) fit = n;
      else break;
    }
    expect(deltaPayloadBytes("a".repeat(fit))).toBe(LIVE_DELTA_MAX_PAYLOAD_BYTES);
    expect(deltaTextFitsPayload("a".repeat(fit + 1))).toBe(false);
  });
});
