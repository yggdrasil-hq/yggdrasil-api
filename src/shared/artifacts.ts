/**
 * The generic half of artifact retention: state, expiry, and sizing.
 *
 * Extracted from `recordings/retention.ts` when screenshots (issue #22) needed
 * the same rules, and extracted rather than copied deliberately. That module's
 * own header explains why this logic is the expensive kind to duplicate:
 * retention has two places where a silent off-by-one is invisible — the expiry
 * boundary, where the sweeper's SQL and the read path's state function must
 * agree on the exact instant an artifact stops being available, and the size
 * cap, where `>` versus `>=` decides whether a claim about the cap is true.
 * Two copies of that are two chances for a purge and a read to disagree, which
 * renders as a clickable link that 404s or as bytes that are never reclaimed.
 * So the rules live here once, and each artifact family supplies only what is
 * genuinely its own (content types, message wording, config).
 *
 * Free of I/O and of `Date.now()`: every function that needs "now" takes it as
 * an argument, so a caller cannot read the clock twice inside one decision and
 * land on two different answers.
 */

/**
 * How an artifact should be presented.
 *
 * Three states rather than a boolean, because "this was captured but the bytes
 * have since been reclaimed" is a genuinely different fact from "this was never
 * captured" — and collapsing them is exactly what makes an expired artifact
 * render as an empty player, or a broken image, with no explanation. The
 * distinction survives reclamation because the sweeper tombstones rows (nulls
 * the bytes, keeps the row) rather than deleting them.
 */
export type ArtifactState = "available" | "expired" | "never_recorded";

/**
 * The facts about a stored artifact that decide its state. Takes primitives
 * rather than a repository row so it can be exercised without a database.
 */
export interface ArtifactFacts {
  /** When retention reclaims the bytes. */
  expiresAt: Date;
  /** Set by the sweeper once the bytes were actually reclaimed. */
  purgedAt: Date | null;
  /** Whether the bytes are still present. */
  hasData: boolean;
}

/**
 * Which of the three states an artifact is in, as of `now`.
 *
 * `expiresAt <= now` is expired, matching every sweeper's own predicate
 * exactly. `hasData` and `purgedAt` are checked as well as the clock so this
 * stays correct if a row is ever purged early (a manual purge, or a future
 * size-pressure sweep) — a tombstoned row is expired regardless of its
 * timestamp, because the bytes are what the user came for.
 */
export function artifactState(facts: ArtifactFacts, now: Date): ArtifactState {
  if (!facts.hasData || facts.purgedAt !== null) {
    return "expired";
  }
  return facts.expiresAt.getTime() <= now.getTime() ? "expired" : "available";
}

/**
 * When an artifact captured at `createdAt` stops being available.
 *
 * Anchored to the artifact's own creation rather than to "now at read time", so
 * the window is a property of the artifact: re-uploading would move it, but
 * merely reading it never does.
 */
export function resolveExpiry(createdAt: Date, retentionDays: number): Date {
  return new Date(createdAt.getTime() + retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Whether an artifact of `byteSize` may be stored, given `maxBytes`.
 *
 * Inclusive upper bound (`>`, not `>=`) — a file of exactly the cap is accepted,
 * so the configured number reads as "the largest artifact you may store" rather
 * than "one byte less than you'd expect". A cap of zero is not a special case
 * for "disable": it refuses every non-empty artifact, and emptiness is refused
 * separately by the caller, so the two rules compose without a sentinel.
 */
export function exceedsSizeCap(byteSize: number, maxBytes: number): boolean {
  return !Number.isFinite(byteSize) || byteSize > maxBytes;
}

/**
 * A stable, human-readable size, for the "Recording · 4.2 MB" line.
 *
 * Decimal units (MB = 10^6) rather than binary (MiB = 2^20), matching how object
 * storage and video tooling report sizes — a 25 MB cap is stated in the same
 * units a user sees on the artifact, so the two never appear to disagree.
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
 * the settings page and a developer reading this module describe the same policy
 * in the same words.
 */
export function formatRetention(retentionDays: number): string {
  if (retentionDays === 1) return "1 day";
  if (retentionDays % 365 === 0) {
    const years = retentionDays / 365;
    return years === 1 ? "1 year" : `${years} years`;
  }
  return `${retentionDays} days`;
}
