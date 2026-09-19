import { describe, expect, it } from "vitest";
import { resumeFromSessionRefusal } from "./grill-resume.js";

/**
 * ADR 032 item 3's resume rule, exercised without HTTP.
 *
 * The route's own tests cover the wiring — project access, the audit row, what the
 * dispatched job carries — and deliberately *not* the refusal matrix, because the
 * matrix has five branches and driving each through Express would test the router
 * rather than the rule. Here every branch is reachable by naming one input.
 */

const POINTS = [
  { entryId: "a1b2c3d4", text: "Add a saved-cards section." },
  { entryId: "c3d4e5f6", text: "Many, with one default." },
];

/** Everything satisfiable, so each test can move exactly one input. */
function allowed(overrides: Partial<Parameters<typeof resumeFromSessionRefusal>[0]> = {}) {
  return {
    featureStatus: "spec_ready",
    latestJobKind: "spec_grill",
    hasActiveGrillJob: false,
    sessionState: "available" as const,
    forkPointState: "captured" as const,
    forkPoints: POINTS,
    entryId: "c3d4e5f6",
    ...overrides,
  };
}

describe("resumeFromSessionRefusal", () => {
  it("allows a resumable run and a point it actually captured", () => {
    expect(resumeFromSessionRefusal(allowed())).toBeNull();
  });

  it("shares the rewind's three conditions, including its status set", () => {
    // Each of the three comes from `grillRedoBlock`, so the two gestures cannot drift
    // about *which* one failed — only about how to word it.
    expect(resumeFromSessionRefusal(allowed({ featureStatus: "running" }))).toMatchObject({
      status: 409,
    });
    expect(
      resumeFromSessionRefusal(allowed({ latestJobKind: "feature_build" })),
    ).toMatchObject({ status: 409 });
    expect(resumeFromSessionRefusal(allowed({ hasActiveGrillJob: true }))).toMatchObject({
      status: 409,
    });
  });

  it("counts every status the API accepts a rewind from as acceptable here too", () => {
    // The four are one shared constant. If one gesture's set were narrowed, the other
    // would silently widen or narrow with it, and this asserts they stay the same set
    // rather than the same *value* today.
    for (const featureStatus of ["draft", "spec_ready", "failed", "cancelled"]) {
      expect(resumeFromSessionRefusal(allowed({ featureStatus }))).toBeNull();
    }
    for (const featureStatus of ["queued", "testing", "agentic_review", "in_review", "merged", "returned", "running"]) {
      expect(resumeFromSessionRefusal(allowed({ featureStatus }))).not.toBeNull();
    }
  });

  it("words a status refusal for a resume rather than for a rewind", () => {
    const refusal = resumeFromSessionRefusal(allowed({ featureStatus: "merged" }));

    // A resume does not discard turns, so the rewind's "can only be rewound" sentence
    // would describe something that is not about to happen.
    expect(refusal?.error).toContain("resumed");
    expect(refusal?.error).not.toContain("rewound");
    expect(refusal?.error).toContain("merged");
  });

  it("refuses every state that is not a forkable one, in that state's own words", () => {
    // The sentences are the read path's, so a user who read the page's notice and a
    // user who hit the refusal are told the same thing about the same state.
    expect(resumeFromSessionRefusal(allowed({ sessionState: "expired" }))?.error).toBe(
      "This run's session was saved but has since been removed after its retention window.",
    );
    expect(resumeFromSessionRefusal(allowed({ sessionState: "not_collected" }))?.error).toBe(
      "This run did not save a session.",
    );
    expect(resumeFromSessionRefusal(allowed({ sessionState: "unavailable" }))?.error).toBe(
      "This run's session could not be retrieved.",
    );
    expect(resumeFromSessionRefusal(allowed({ sessionState: "unknown" }))?.error).toBe(
      "No session was reported for this run.",
    );
  });

  it("keeps the two ways resume points can be missing apart", () => {
    const failed = resumeFromSessionRefusal(
      allowed({ forkPointState: "unavailable", forkPoints: null }),
    );
    const neverTold = resumeFromSessionRefusal(
      allowed({ forkPointState: "unknown", forkPoints: null }),
    );

    // ADR 032 item 5's rule applied to the capture: "the attempt failed" and "nobody
    // asked" are different claims, and neither is "there are no points" — which only a
    // captured, empty list means.
    expect(failed?.status).toBe(409);
    expect(neverTold?.status).toBe(409);
    expect(failed?.error).not.toBe(neverTold?.error);
    expect(failed?.error).not.toContain("No resumable points");
  });

  it("404s an entry id that is not among the captured points", () => {
    const refusal = resumeFromSessionRefusal(allowed({ entryId: "deadbeef" }));

    // 404 rather than 409 — the caller named something not in this run's
    // conversation, which is how the sibling rewind answers a turn that is not in the
    // transcript. Refusing here is what stops the Orchestrator burning a pod to
    // discover a fact this API already holds.
    expect(refusal).toMatchObject({ status: 404 });
    expect(refusal?.error).toContain("resume point");
  });

  it("refuses every entry id when the capture is a genuine empty list", () => {
    // A `captured` empty list is an answer: Pi reported no resumable user messages.
    // Validating against it must refuse, not skip the check because the list is empty
    // — a truthiness test here would accept any id at all.
    expect(
      resumeFromSessionRefusal(allowed({ forkPoints: [] })),
    ).toMatchObject({ status: 404 });
  });

  it("refuses rather than crashing when a captured state carries no list", () => {
    // The table's CHECK makes this unwritable, so it is not a reachable state — but the
    // function treats it as a refusal rather than asserting, so a future relaxation of
    // that constraint degrades to a message instead of a 500.
    expect(
      resumeFromSessionRefusal(allowed({ forkPoints: null })),
    ).toMatchObject({ status: 404 });
  });
});
