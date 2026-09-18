import { describe, expect, it } from "vitest";
import { toPublicAgenticReview } from "./review-types.js";
import type { JobEvent } from "../jobs/events-repository.js";

/**
 * Issue #59: the Agentic Review read shape.
 *
 * The case that matters most is the empty one. The tab has been rendering
 * "Unable to load agentic review." for a feature nobody has reviewed, because it
 * was a 404 — so "no review" and "the request failed" were the same thing to the
 * client, and the honest empty state its own doc comment promises was unreachable.
 */

function makeEvent(overrides: Partial<JobEvent> = {}): JobEvent {
  return {
    id: "evt_1",
    jobId: "job_1",
    type: "submit_review",
    question: null,
    markdown: null,
    message: null,
    status: null,
    prUrl: null,
    summary: "Auth flow is missing the token refresh path.",
    verdict: "changes_requested",
    actionItems: null,
    snapshot: null,
    createdAt: new Date("2026-09-18T10:00:00.000Z"),
    ...overrides,
  };
}

describe("toPublicAgenticReview", () => {
  it("maps a recorded review", () => {
    expect(toPublicAgenticReview(makeEvent())).toEqual({
      verdict: "changes_requested",
      summary: "Auth flow is missing the token refresh path.",
      comments: [],
      jobId: "job_1",
      completedAt: "2026-09-18T10:00:00.000Z",
    });
  });

  it("maps an approval", () => {
    expect(toPublicAgenticReview(makeEvent({ verdict: "approved" })).verdict).toBe("approved");
  });

  // The whole point of the endpoint's null branch: a feature that has never been
  // reviewed gets a fully-shaped body, not a 404, so the client's empty state is
  // a different code path from its error state.
  it("returns a fully-shaped body for a feature that was never reviewed", () => {
    const review = toPublicAgenticReview(null);

    expect(review).toEqual({
      verdict: null,
      summary: null,
      comments: [],
      jobId: null,
      completedAt: null,
    });
  });

  it("always returns an array for comments, so a client can render a list", () => {
    // `undefined` here would crash a `.map` rather than render an empty list.
    expect(Array.isArray(toPublicAgenticReview(null).comments)).toBe(true);
    expect(Array.isArray(toPublicAgenticReview(makeEvent()).comments)).toBe(true);
  });

  // Issue #59's migration note: reviews written before the verdict column existed
  // have none recorded, and it cannot be recovered. Reporting NULL is the honest
  // answer; inventing one from the feature's status would be a fabrication.
  it("reports a null verdict when the row predates the verdict column", () => {
    expect(toPublicAgenticReview(makeEvent({ verdict: null })).verdict).toBeNull();
  });

  it("drops a verdict it does not recognise rather than passing it through", () => {
    // The column has a CHECK constraint, so this is unreachable through the API —
    // but a client that received an unknown verdict would have to invent a
    // rendering for it, and "not recorded" is the truthful fallback.
    expect(toPublicAgenticReview(makeEvent({ verdict: "lgtm" })).verdict).toBeNull();
  });

  // The event's own timestamp, not the job's completed_at: it is the moment the
  // verdict was submitted, which is what "when was this reviewed" means. Using
  // the job's completion would also make a verdict recorded by a job that later
  // crashed look undated.
  it("dates the review from the event, so a recorded verdict is never undated", () => {
    expect(
      toPublicAgenticReview(makeEvent({ createdAt: new Date("2026-01-02T03:04:05.000Z") }))
        .completedAt,
    ).toBe("2026-01-02T03:04:05.000Z");
  });

  it("carries the producing job's id so the UI can link to it", () => {
    expect(toPublicAgenticReview(makeEvent({ jobId: "job_9" })).jobId).toBe("job_9");
  });
});
