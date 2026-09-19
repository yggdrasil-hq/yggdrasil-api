import type { SessionOutcome, SessionState } from "./retention.js";

/**
 * ADR 032 item 1: one job's Pi session file, as stored.
 *
 * Not exportable as a whole — see `toPublicJobSession`, which deliberately drops
 * the pod path and never carries bytes. The split follows `JobRecording` exactly,
 * and for the same reason: a run-history response must not balloon to the size of
 * the artifact it describes.
 */
export interface JobSession {
  jobId: string;
  projectId: string;
  outcome: SessionOutcome;
  /** Pi's own session id, or null when Pi reported none. */
  sessionId: string | null;
  /** The pod-local path the bytes were read from. Evidence, not a key. */
  podFilePath: string | null;
  /** Null for a failing outcome — a session that was never read has no size. */
  byteSize: number | null;
  /** Null for a failing outcome — nothing was ever stored, so nothing expires. */
  expiresAt: Date | null;
  purgedAt: Date | null;
  createdAt: Date;
}

/** A session plus its bytes — only fetched by the download path. */
export interface JobSessionContent extends JobSession {
  data: Buffer | null;
}

/**
 * What the Web app is told about a session.
 *
 * Carries no path and no bytes, and **carries no fork points**: ADR 032 item 2
 * sources those from `get_fork_messages`, which is an RPC to a live Pi process and
 * is therefore unavailable once the pod is gone (nothing captures it yet). A
 * `forkPoints: []` here would be the seventh instance of this suite's
 * declared-but-discarded shape — a field whose emptiness reads as "there are none"
 * when the truth is "nobody has asked". So the response says what is true: whether
 * a fork is possible at all, and why not when it is not.
 *
 * `state` is computed server-side from the same rule the sweeper's SQL mirrors, so
 * the client cannot drift from the server about whether an artifact is still there
 * — following `toPublicJobRecording`.
 */
export interface PublicJobSession {
  jobId: string;
  state: SessionState;
  /**
   * The Orchestrator's own outcome, echoed verbatim.
   *
   * Redundant with `state` for the three stored outcomes and kept anyway, because
   * it is the *wire* value: a client grouping by outcome, or an operator comparing
   * an API response against an Orchestrator log line, needs the string both sides
   * actually use rather than a translation of it. Null when there is no row, where
   * no outcome was ever reported.
   */
  outcome: SessionOutcome | null;
  /** Pi's session id, when one was reported. */
  sessionId: string | null;
  byteSize: number | null;
  expiresAt: string | null;
  purgedAt: string | null;
  createdAt: string | null;
  /**
   * Whether ADR 032 item 3's non-destructive "resume from here" could be attempted
   * against this artifact.
   *
   * Derived from `state` rather than stored, so it cannot disagree with the state
   * the same response carries. False does **not** mean the control is hidden: the
   * shipped destructive rewind (ADR 024) remains available as the fallback item 5
   * requires, which needs nothing but the transcript in `job_events`.
   */
  canFork: boolean;
}

export function toPublicJobSession(input: {
  jobId: string;
  session: JobSession | null;
  state: SessionState;
  canFork: boolean;
}): PublicJobSession {
  const { session } = input;
  return {
    jobId: input.jobId,
    state: input.state,
    outcome: session?.outcome ?? null,
    sessionId: session?.sessionId ?? null,
    byteSize: session?.byteSize ?? null,
    expiresAt: session?.expiresAt?.toISOString() ?? null,
    purgedAt: session?.purgedAt?.toISOString() ?? null,
    createdAt: session?.createdAt.toISOString() ?? null,
    canFork: input.canFork,
  };
}

/**
 * What a *refused* operation is told (ADR 032 item 5).
 *
 * The three outcomes get different words because they are different facts, and the
 * whole point of item 5 is that the user is not handed one sentence for all three.
 * `null` state (no row) gets its own wording rather than borrowing
 * `not_collected`'s, because "we were never told" and "this run produced no
 * session" are separate claims — see `SessionState`.
 */
export function sessionStateExplanation(state: SessionState): string {
  switch (state) {
    case "available":
      return "This run's session was saved.";
    case "expired":
      return "This run's session was saved but has since been removed after its retention window.";
    case "not_collected":
      return "This run did not save a session.";
    case "unavailable":
      return "This run's session could not be retrieved.";
    case "unknown":
      return "No session was reported for this run.";
  }
}
