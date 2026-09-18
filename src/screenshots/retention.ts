/**
 * Issue #22: the screenshot-specific half of artifact retention.
 *
 * The generic rules live in `shared/artifacts.ts` — see that module for why the
 * expiry boundary and the size cap are implemented once rather than per artifact
 * family. What is here is what is genuinely about screenshots: which image
 * formats are acceptable, and how a refusal is worded.
 */

import {
  exceedsSizeCap,
  formatByteSize,
  type ArtifactFacts,
  type ArtifactState,
} from "../shared/artifacts.js";

/** A screenshot's presentation state — the shared artifact states, under this feature's name. */
export type ScreenshotState = ArtifactState;

/** A screenshot's retention facts — the shared artifact facts, under this feature's name. */
export type ScreenshotFacts = ArtifactFacts;

/**
 * Image formats a screenshot may arrive in.
 *
 * All three are formats a browser renders directly and inertly. **SVG is
 * deliberately absent**: an SVG is a document that can carry script, and these
 * bytes are served inline from the API's own origin behind a session cookie, so
 * accepting one would be stored XSS against every member of the project. A
 * format whitelist is the only place that can be enforced cheaply, so it is
 * enforced here *and* by the table's CHECK constraint.
 *
 * Playwright's `page.screenshot()` emits PNG by default and WebP/JPEG when asked,
 * so all three are reachable in practice rather than speculative.
 */
export const SCREENSHOT_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ScreenshotContentType = (typeof SCREENSHOT_CONTENT_TYPES)[number];

/** PNG, because that is what a default Playwright screenshot is. */
export const DEFAULT_SCREENSHOT_CONTENT_TYPE: ScreenshotContentType = "image/png";

/** Whether a reported content type is one a browser renders safely as an image. */
export function isSupportedScreenshotType(value: string): value is ScreenshotContentType {
  return (SCREENSHOT_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * Why an upload was refused, or null when it is acceptable.
 *
 * Returned as a reason rather than thrown, matching `rejectUpload`'s contract for
 * recordings: the Orchestrator records the reason and lets the job finish. A
 * screenshot is diagnostic evidence attached to a run (ADR 029 item 5 for
 * recordings, and the same reasoning applies — an artifact must never fail the
 * test run that produced it), so a refusal is a note, not an error.
 *
 * `screenshotsForJob` and `maxPerJob` are passed in rather than read from config
 * so the whole rule is testable as one pure function, including the count cap
 * that bounds a job's total screenshot storage rather than just one file's size.
 */
export function rejectScreenshotUpload(input: {
  contentType: string;
  byteSize: number;
  maxBytes: number;
  /** How many screenshots this job already has stored (tombstones included). */
  screenshotsForJob: number;
  maxPerJob: number;
}): string | null {
  if (input.byteSize <= 0) {
    return "Screenshot was empty";
  }
  if (exceedsSizeCap(input.byteSize, input.maxBytes)) {
    return `Screenshot exceeds the ${formatByteSize(input.maxBytes)} limit (${formatByteSize(input.byteSize)})`;
  }
  if (!isSupportedScreenshotType(input.contentType)) {
    return `Unsupported screenshot format: ${input.contentType}`;
  }
  if (input.maxPerJob > 0 && input.screenshotsForJob >= input.maxPerJob) {
    // The per-job count cap, and the reason it exists separately from the size
    // cap: a test spec's `##` headings decide how many steps there are, so
    // without this a spec with thousands of headings is thousands of files.
    // Bounded per file is not bounded per run.
    return `This run already has the maximum of ${input.maxPerJob} screenshots`;
  }
  return null;
}

/**
 * A step name trimmed and validated for storage, or null when it cannot be used.
 *
 * Step names are `##` headings from the project's own test markdown, so they are
 * free text: they may arrive with padding, and they may be empty after trimming
 * (a heading of only whitespace). A name is the key this artifact is addressed
 * by, so an unusable one is a refusal rather than something to normalise into a
 * collision with another step.
 *
 * The cap matches the column's `VARCHAR(256)`: rejecting here produces a reason
 * the caller can log, where letting the database reject it would surface as an
 * opaque constraint violation.
 */
export const MAX_STEP_NAME_LENGTH = 256;

export function normalizeStepName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_STEP_NAME_LENGTH) return null;
  return trimmed;
}
