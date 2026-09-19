import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCREENSHOT_CONTENT_TYPE,
  MAX_STEP_NAME_LENGTH,
  SCREENSHOT_CONTENT_TYPES,
  isSupportedScreenshotType,
  normalizeStepName,
  rejectScreenshotUpload,
} from "./retention.js";

/**
 * Issue #22's screenshot-specific rules.
 *
 * The generic retention rules (the three states, the expiry boundary, the size
 * cap) are covered by `recordings/retention.test.ts`, which now exercises the
 * shared implementation in `shared/artifacts.ts` — one set of assertions for one
 * implementation, which is the point of the extraction.
 */

function reject(overrides: Partial<Parameters<typeof rejectScreenshotUpload>[0]> = {}) {
  return rejectScreenshotUpload({
    contentType: "image/png",
    byteSize: 120_000,
    maxBytes: 2_000_000,
    screenshotsForJob: 0,
    maxPerJob: 50,
    ...overrides,
  });
}

describe("screenshot content types", () => {
  it("accepts the formats Playwright can produce", () => {
    for (const contentType of SCREENSHOT_CONTENT_TYPES) {
      expect(isSupportedScreenshotType(contentType), contentType).toBe(true);
    }
    expect(DEFAULT_SCREENSHOT_CONTENT_TYPE).toBe("image/png");
  });

  it("refuses SVG, which is the one image format that can carry script", () => {
    // The security boundary of this feature. An SVG is a *document*, not a
    // bitmap: it can contain <script> and event handlers, and these bytes are
    // served inline from the API's own origin behind a session cookie. Accepting
    // one would be stored XSS against every member of the project, so this is
    // asserted explicitly rather than left implied by the whitelist's contents.
    expect(isSupportedScreenshotType("image/svg+xml")).toBe(false);
    expect(reject({ contentType: "image/svg+xml" })).toContain("Unsupported");
  });

  it("refuses non-image types and lookalikes", () => {
    for (const contentType of [
      "text/html",
      "application/javascript",
      "image/gif",
      "image/png+xml",
      "video/webm",
      "",
    ]) {
      expect(isSupportedScreenshotType(contentType), contentType).toBe(false);
    }
  });
});

describe("rejectScreenshotUpload", () => {
  it("accepts a normal screenshot", () => {
    expect(reject()).toBeNull();
  });

  it("refuses an empty body", () => {
    // Separate from the size cap rather than relying on it: a cap of 0 would
    // otherwise refuse everything, and the two rules compose without a sentinel.
    expect(reject({ byteSize: 0 })).toBe("Screenshot was empty");
    expect(reject({ byteSize: -1 })).toBe("Screenshot was empty");
  });

  it("accepts a screenshot of exactly the cap and refuses one byte more", () => {
    // `>` not `>=`, so the configured number reads as "the largest screenshot you
    // may store" rather than "one byte less than you'd expect".
    expect(reject({ byteSize: 2_000_000, maxBytes: 2_000_000 })).toBeNull();
    expect(reject({ byteSize: 2_000_001, maxBytes: 2_000_000 })).toContain(
      "exceeds the 2.0 MB limit",
    );
  });

  it("treats a byte cap of zero as refusing everything, not as switched off", () => {
    // Issue #107. The half of the pair that had no test: `exceedsSizeCap` is
    // `byteSize > maxBytes`, so zero refuses every non-empty screenshot. This is
    // the SAME reading as `RECORDING_MAX_BYTES` and `SESSION_MAX_BYTES`, and the
    // OPPOSITE of the per-job cap tested two cases below.
    //
    // Empty is refused by its own rule regardless (see the case above), so the
    // input here is deliberately a normal non-empty body: the claim is about the
    // size cap's reading and not about emptiness leaking in.
    expect(reject({ byteSize: 120_000, maxBytes: 0 })).toContain("exceeds the 0 B limit");
    expect(reject({ byteSize: 1, maxBytes: 0 })).not.toBeNull();
  });

  it("refuses a non-finite size rather than letting it through", () => {
    expect(reject({ byteSize: Number.NaN })).not.toBeNull();
    expect(reject({ byteSize: Number.POSITIVE_INFINITY })).not.toBeNull();
  });

  it("refuses past the per-job count cap", () => {
    // The bound that a per-file cap cannot express: how many steps there are is
    // decided by the test markdown's `##` headings, so a spec with thousands of
    // headings is thousands of files. Bounded per file is not bounded per run.
    expect(reject({ screenshotsForJob: 49, maxPerJob: 50 })).toBeNull();
    expect(reject({ screenshotsForJob: 50, maxPerJob: 50 })).toContain(
      "maximum of 50 screenshots",
    );
  });

  it("treats a per-job cap of zero as switched off", () => {
    // Issue #107. Zero here means **no per-run ceiling at all**, which is the
    // OPPOSITE of the byte cap's zero above — the two share a prefix and sit
    // adjacent in the env file, so the pair is exactly what an operator can
    // misread. Naming the direction is what makes it memorable: this one fails
    // *open*, that one fails *closed*.
    //
    // The reading is not a choice made here — the guard is `maxPerJob > 0 && …`, so
    // zero skipping the check is what the expression already says. It matches
    // `LIVE_DELTA_BYTES_PER_JOB`, whose zero the delta relay reads the same way.
    //
    // What zero does NOT switch off: the byte cap above still refuses an oversized
    // file, and retention still reclaims as screenshots age. Only the count bound —
    // the one that exists because a spec's heading count is not ours to control —
    // is gone.
    expect(reject({ screenshotsForJob: 9_999, maxPerJob: 0 })).toBeNull();
  });

  it("reads zero in opposite directions for the two caps, so neither can be assumed from the other", () => {
    // The assertion a future edit that "unifies" the pair has to break, and the
    // reason it sits beside the two cases above rather than only under each cap:
    // each cap's own case passes under a unification, because a unified rule still
    // produces *a* value at zero. Only asserting that the two DIFFER catches it.
    //
    // Same input shape in both halves — a normal 120 kB screenshot, a job with
    // screenshots already — with zero in one variable and a real value in the other,
    // so the outcome differs only because the two zeros mean different things.

    // The byte cap: zero refuses it.
    expect(
      reject({ byteSize: 120_000, maxBytes: 0, screenshotsForJob: 9_999, maxPerJob: 50 }),
    ).toContain("exceeds the 0 B limit");

    // The per-job cap: zero lets the ten-thousandth screenshot through.
    expect(
      reject({ byteSize: 120_000, maxBytes: 2_000_000, screenshotsForJob: 9_999, maxPerJob: 0 }),
    ).toBeNull();
  });

  it("checks size before count, so an oversized file is reported as oversized", () => {
    // Both are true here; the reason a caller logs should be the one they can act
    // on, and "too big" is fixable by the producer while "at quota" is not.
    expect(
      reject({ byteSize: 9_000_000, maxBytes: 2_000_000, screenshotsForJob: 50 }),
    ).toContain("exceeds");
  });
});

describe("normalizeStepName", () => {
  it("trims padding, because a heading may arrive with it", () => {
    expect(normalizeStepName("  Step 1  ")).toBe("Step 1");
  });

  it("accepts names that are not identifiers", () => {
    // Step names are `##` headings from a project's own markdown: spaces,
    // punctuation, unicode and slashes all legitimately appear.
    for (const name of ["Opens the cart", "café checkout", "a/b/c", "50% off?", "🙂"]) {
      expect(normalizeStepName(name), name).toBe(name);
    }
  });

  it("refuses an empty or whitespace-only name", () => {
    // A name is the key this artifact is addressed by, so an unusable one is a
    // refusal rather than something normalised into a collision with another step.
    for (const name of ["", "   ", "\n", "\t"]) {
      expect(normalizeStepName(name), JSON.stringify(name)).toBeNull();
    }
  });

  it("refuses a non-string", () => {
    for (const value of [undefined, null, 42, {}, [], true]) {
      expect(normalizeStepName(value)).toBeNull();
    }
  });

  it("accepts exactly the column's length and refuses one more", () => {
    // Matching VARCHAR(256) here rather than letting Postgres reject it produces a
    // reason the caller can log, instead of an opaque constraint violation.
    expect(normalizeStepName("x".repeat(MAX_STEP_NAME_LENGTH))).toHaveLength(
      MAX_STEP_NAME_LENGTH,
    );
    expect(normalizeStepName("x".repeat(MAX_STEP_NAME_LENGTH + 1))).toBeNull();
  });

  it("measures after trimming, so padding cannot push a valid name over", () => {
    const name = "x".repeat(MAX_STEP_NAME_LENGTH);
    expect(normalizeStepName(`  ${name}  `)).toBe(name);
  });
});
