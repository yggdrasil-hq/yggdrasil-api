/**
 * ADR 029: the pure half of test-run screen recordings.
 *
 * Every decision the recording feature makes about *whether an artifact exists,
 * what it is allowed to be, and when it stops existing* lives here rather than
 * in the repository or the route handlers, because recording retention has two
 * places where a silent off-by-one is expensive and invisible:
 *
 * 1. **The expiry boundary.** The sweeper's SQL and this module's state
 *    function must agree on the exact instant a recording stops being
 *    available. If they disagree, a recording is either a clickable link that
 *    404s (the sweeper won, the state function didn't) or bytes that should
 *    have been reclaimed but never are. `expires_at <= now` is the single
 *    rule, and it is inclusive on both sides.
 *
 * 2. **The size cap.** A recording is orders of magnitude larger than the JSON
 *    report it accompanies, so an unbounded upload is a way to exhaust the
 *    database. The comparison is `>`, never `>=`: a recording of exactly the
 *    cap is accepted, so the configured number reads as "the largest
 *    recording you may store" rather than "one byte less than you'd expect".
 *
 * The module is deliberately free of I/O and of `Date.now()` — every function
 * that needs "now" takes it as an argument, so a caller cannot accidentally
 * read the clock twice within one decision and land on two different answers.
 */

/**
 * How a run's recording should be presented.
 *
 * Three states rather than a boolean, because "this run was recorded but the
 * artifact has since been reclaimed" is a genuinely different fact from "this
 * run was never recorded" — and collapsing them is exactly what makes an
 * expired recording render as an empty player with no explanation. The
 * distinction survives reclamation because the sweeper tombstones rows (nulls
 * the bytes, keeps the row) rather than deleting them; see `repository.ts`.
 */
export type RecordingState = "available" | "expired" | "never_recorded";

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

/**
 * The facts about a stored recording that decide its state. Takes primitives
 * rather than a repository row so it can be exercised without a database.
 */
export interface RecordingFacts {
  /** When retention reclaims the bytes. */
  expiresAt: Date;
  /** Set by the sweeper once the bytes were actually reclaimed. */
  purgedAt: Date | null;
  /** Whether the bytes are still present. */
  hasData: boolean;
}

/**
 * Which of the three states a recording is in, as of `now`.
 *
 * `expiresAt <= now` is expired, matching the sweeper's own predicate exactly.
 * `hasData` and `purgedAt` are checked as well as the clock so this stays
 * correct if a row is ever purged early (a manual purge, or a future
 * size-pressure sweep) — a tombstoned row is expired regardless of its
 * timestamp, because the bytes are what the user came for.
 */
export function recordingState(facts: RecordingFacts, now: Date): RecordingState {
  if (!facts.hasData || facts.purgedAt !== null) {
    return "expired";
  }
  return facts.expiresAt.getTime() <= now.getTime() ? "expired" : "available";
}

/**
 * When a recording captured at `createdAt` stops being available.
 *
 * Anchored to the recording's own creation rather than to "now at read time",
 * so the window is a property of the artifact: re-uploading would move it, but
 * merely reading it never does.
 */
export function resolveExpiry(createdAt: Date, retentionDays: number): Date {
  return new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Whether an artifact of `byteSize` may be stored, given `maxBytes`.
 *
 * Inclusive upper bound (`>`, not `>=`) — see this module's header. A cap of
 * zero is not a special case for "disable": it refuses every non-empty
 * artifact, and emptiness is refused separately by the caller, so the two rules
 * compose without a sentinel.
 */
export function exceedsSizeCap(byteSize: number, maxBytes: number): boolean {
  return !Number.isFinite(byteSize) || byteSize > maxBytes;
}

/** Whether a reported content type is one a browser can play back. */
export function isSupportedContentType(value: string): value is RecordingContentType {
  return (RECORDING_CONTENT_TYPES as readonly string[]).includes(value);
}

/**
 * A stable, human-readable size, for the "Recording · 4.2 MB" line.
 *
 * Decimal units (MB = 10^6) rather than binary (MiB = 2^20), matching how
 * object storage and video tooling report sizes — a 25 MB cap is stated in the
 * same units a user sees on the artifact, so the two never appear to disagree.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1_000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1_000;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The retention window stated the way the UI phrases it, so an operator reading
 * the settings page and a developer reading this module describe the same
 * policy in the same words.
 */
export function formatRetention(retentionDays: number): string {
  if (retentionDays === 1) return "1 day";
  if (retentionDays % 365 === 0) {
    const years = retentionDays / 365;
    return years === 1 ? "1 year" : `${years} years`;
  }
  return `${retentionDays} days`;
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
