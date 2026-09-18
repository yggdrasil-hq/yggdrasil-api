/**
 * ADR 029: the recording-specific half of artifact retention.
 *
 * The generic rules — the three states, the expiry boundary, the size cap and
 * the human-readable sizes — live in `shared/artifacts.ts`, because screenshots
 * (issue #22) obey exactly the same rules, and duplicating them is how a purge
 * and a read end up disagreeing about the instant an artifact stops existing.
 * What is left here is only what is genuinely about recordings: which container
 * formats are acceptable, and how a refusal is worded.
 *
 * The re-exports keep this module's public surface unchanged, so every existing
 * caller and test keeps importing from `./retention.js`. They are aliases, not
 * copies — there is one implementation of each rule.
 */

import {
  artifactState,
  exceedsSizeCap,
  formatByteSize,
  type ArtifactFacts,
  type ArtifactState,
} from "../shared/artifacts.js";

export {
  exceedsSizeCap,
  formatByteSize,
  formatRetention,
  resolveExpiry,
} from "../shared/artifacts.js";

/** A recording's presentation state — the shared artifact states, under this feature's name. */
export type RecordingState = ArtifactState;

/** A recording's retention facts — the shared artifact facts, under this feature's name. */
export type RecordingFacts = ArtifactFacts;

/**
 * Which of the three states a recording is in, as of `now`.
 *
 * An alias for the shared rule rather than a second implementation of it; the
 * reasoning for the boundary lives on `artifactState`. Kept under this name
 * because `recordings/routes.ts` and `recordings/types.ts` read better saying
 * "recording state" than "artifact state" at their call sites.
 */
export const recordingState = artifactState;

/** Container formats a recording may arrive in. */
export const RECORDING_CONTENT_TYPES = ["video/webm", "video/mp4"] as const;
export type RecordingContentType = (typeof RECORDING_CONTENT_TYPES)[number];

/**
 * Playwright's own video writer emits WebM (VP8/VP9), so that is what a real
 * run produces and the default. MP4 is accepted as well because a project may
 * legitimately hand us one — the agent's workspace is its own, and refusing a
 * playable MP4 to insist on a container we did not choose would be a rule
 * without a reason. `video/quicktime` and friends are *not* accepted: browsers
 * cannot play them in a `<video>` element without a plugin, so storing one
 * would produce a download that looks broken.
 */
export const DEFAULT_RECORDING_CONTENT_TYPE: RecordingContentType = "video/webm";

/** Whether a reported content type is one a browser can play back. */
export function isSupportedContentType(value: string): value is RecordingContentType {
  return (RECORDING_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * Why an upload was refused, or null when it is acceptable. Returned as a
 * reason rather than thrown, because the Orchestrator treats every refusal the
 * same way — it records the reason and lets the job finish (ADR 029: a
 * recording must never fail a test run).
 */
export function rejectUpload(input: {
  contentType: string;
  byteSize: number;
  maxBytes: number;
}): string | null {
  if (input.byteSize <= 0) {
    return "Recording was empty";
  }
  if (exceedsSizeCap(input.byteSize, input.maxBytes)) {
    return `Recording exceeds the ${formatByteSize(input.maxBytes)} limit (${formatByteSize(input.byteSize)})`;
  }
  if (!isSupportedContentType(input.contentType)) {
    return `Unsupported recording format: ${input.contentType}`;
  }
  return null;
}
