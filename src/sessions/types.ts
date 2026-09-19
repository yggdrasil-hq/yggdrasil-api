import {
  UNKNOWN_FORK_POINT_STATE,
  type ForkPointOutcome,
  type ForkPointState,
  type SessionOutcome,
  type SessionState,
} from "./retention.js";

/**
 * ADR 032 item 2: one previous user message a stored session can be forked from.
 *
 * `entryId` is Pi's own entry id — a durable cursor into the session tree, and a
 * **different id space** from a grill `job_events` id. Both exist in this suite and
 * they mean different things (ADR 032's trade-offs record that explicitly, because
 * a reader assuming they are interchangeable is the mistake item 2 was written to
 * avoid). `text` is the user message itself, which is what a user picks from and
 * what the fork re-answers.
 */
export interface ForkPoint {
  entryId: string;
  text: string;
}

/**
 * A run's fork points as stored, plus the state they are read in.
 *
 * `points` is non-null **iff** the state is `captured`, mirroring the table's
 * CHECK: an answered question always has a list (possibly empty) and an unanswered
 * one never has anything. That is what keeps `[]` from having to mean two things.
 */
export interface JobForkPoints {
  jobId: string;
  state: ForkPointState;
  outcome: ForkPointOutcome | null;
  points: ForkPoint[] | null;
  capturedAt: Date | null;
}

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
 * Carries no path and never any bytes. It **does** carry the fork points (item 2),
 * as their own field with their own state — a doc comment here said otherwise until
 * ADR 032 item 3's work landed, which made this response the thing a resume control
 * is built from. The distinction that comment was protecting is still the rule: it is
 * `forkPoints.state` that says whether the list is an answer, because a bare empty
 * list would read as "there are none" when the truth may be "nobody asked".
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
   *
   * Note that this is `true` when the *bytes* are there, independently of whether
   * any fork point is known — a session can be available with `forkPoints.state ===
   * "unknown"`, and the UI must say "we could not find out which points you can
   * resume from" rather than present an empty list as if it were an answer.
   */
  canFork: boolean;
  /**
   * The fork points ADR 032 item 2 captured, and whether they are known at all.
   *
   * Separate from `canFork` on purpose: that field answers "are the bytes there",
   * this one answers "do we know where you could resume from". They are genuinely
   * independent — the capture can fail while the session is stored, and the session
   * can be stored while no capture was ever reported — and collapsing them would
   * lose the distinction between "nothing to resume from" and "we could not find
   * out".
   *
   * This is what the resume control offers a choice *from*, and its state is what
   * decides whether there is a choice at all: only `captured` gives a list.
   */
  forkPoints: {
    state: ForkPointState;
    /** Non-null iff `state === "captured"`; may be empty, which is a real answer. */
    points: ForkPoint[] | null;
  };
}

export function toPublicJobSession(input: {
  jobId: string;
  session: JobSession | null;
  state: SessionState;
  canFork: boolean;
  forkPoints: JobForkPoints | null;
}): PublicJobSession {
  const { session, forkPoints } = input;
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
    // No row is `unknown`, never `captured` with an empty list: only the
    // Orchestrator's report can say "Pi answered and there are none", and a missing
    // row says only that this API was never told. The type makes the second
    // impossible to express by accident, since `captured` requires a non-null list.
    forkPoints: {
      state: forkPoints?.state ?? UNKNOWN_FORK_POINT_STATE,
      points: forkPoints?.points ?? null,
    },
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

/**
 * What the fork-points state means, in words (ADR 032 item 5, second question).
 *
 * `unknown` and a `captured` empty list must not read the same, because they are
 * different claims: the first is "nobody found out whether there is anything to
 * resume from", the second is "there is nothing to resume from". A caller that
 * rendered both as an empty list would be asserting the second on the strength of
 * the first, which is exactly the bug `rpc.SessionFile.Asked` was added to fix on
 * the session side.
 *
 * The `captured` case is worded as a fact rather than as an instruction because
 * the control it describes belongs to the page, which knows whether the session is
 * still there — this function describes the *fork points*, not what to do.
 */
export function forkPointStateExplanation(state: ForkPointState): string {
  switch (state) {
    case "captured":
      return "The points this session can resume from were recorded.";
    case "unavailable":
      return "Which points this session can resume from could not be determined.";
    case "unknown":
      return "No resumable points were reported for this run.";
  }
}
