import {
  grillRedoBlock,
  type GrillRedoBlock,
} from "./grill-context.js";
import type { ForkPoint } from "../sessions/types.js";
import {
  permitsFork,
  type ForkPointState,
  type SessionState,
} from "../sessions/retention.js";
import { forkPointStateExplanation, sessionStateExplanation } from "../sessions/types.js";

/**
 * ADR 032 item 3: the decision behind "resume from here".
 *
 * A *fork* is a `spec_grill` job seeded from an earlier run's stored Pi session
 * rather than from a reconstruction, branching at one of that session's resume
 * points. This module is the API's whole rule for whether such a request may be
 * dispatched, kept pure and separate from the route so every refusal is reachable
 * in a unit test without HTTP — the same reason `grill-context.ts` holds ADR 024's
 * rule.
 *
 * ## Why it is a decision function rather than a boolean
 *
 * Five different things can refuse a resume, and **three of them are answers about
 * the run rather than about the request**: the session was never collected, the
 * session was collected but its resume points could not be determined, and the
 * session was collected with points but not the one asked for. ADR 032 item 5
 * requires those to be told apart, so this returns the refusal *with its status and
 * sentence* rather than a flag — a boolean would push the distinction back into the
 * route, where it would be re-derived a second time.
 *
 * ## Why the sentences are not written here
 *
 * Two of them are the same sentences the Spec page already shows for the same
 * states, taken from `sessionStateExplanation` / `forkPointStateExplanation`. A
 * second wording here would be a second reading of one fact, free to drift from the
 * one the page renders — so the refusal quotes the state's own explanation instead.
 * The entry-point sentence *is* local, because it has no state: "this session was
 * captured and that id is not one of its points" is a fact about the request.
 */

/**
 * A refusal: the status the route answers with, and the sentence it carries.
 *
 * 409 for "the feature, the run or its artifact is not in a state that permits
 * this" — the request is well formed and retryable in principle, which is what the
 * sibling rewind route uses for its own gate. 404 for an entry id that is not a
 * resume point of the named run's conversation, mirroring how the rewind route
 * answers a turn that is not in the transcript: the caller named something that is
 * not there.
 */
export interface ResumeRefusal {
  status: 404 | 409;
  error: string;
}

/**
 * The refusal for a resume request against one run, or null when it may proceed.
 *
 * Every input is a fact the route already has to fetch, so this adds no queries —
 * and passing them in is what lets the *order* of the checks be asserted, which
 * matters because the gates are nested (the entry id can only be judged once the
 * points are known to be captured).
 */
export function resumeFromSessionRefusal(input: {
  /** The feature's status, for the shared per-message gate. */
  featureStatus: string;
  /** The kind of the feature's latest job — the run a resume may branch from. */
  latestJobKind: string | null;
  hasActiveGrillJob: boolean;
  /** The stored session's availability, via `storedSessionState`. */
  sessionState: SessionState;
  /** What `get_fork_messages` has happened to, per the stored capture. */
  forkPointState: ForkPointState;
  /** The captured points, non-null iff `forkPointState === "captured"`. */
  forkPoints: ForkPoint[] | null;
  /** The resume point the caller chose. */
  entryId: string;
}): ResumeRefusal | null {
  /*
   * The three conditions a per-message gesture always has, shared with the rewind
   * through `grillRedoBlock` so the two cannot drift about which one failed. The
   * sentences are this gesture's own: a resume does not discard turns, so the
   * rewind's wording ("A grill can only be rewound…") would misdescribe what the
   * user asked for.
   */
  const block: GrillRedoBlock | null = grillRedoBlock({
    status: input.featureStatus,
    latestJobKind: input.latestJobKind,
    hasActiveGrillJob: input.hasActiveGrillJob,
  });
  if (block !== null) {
    return { status: 409, error: resumeBlockRefusal(block, input.featureStatus) };
  }

  /*
   * The bytes. `permitsFork` is the same predicate the read response derives
   * `canFork` from, reached here through `storedSessionState`, so "the page offered
   * the control" and "the API accepts it" are one decision rather than two.
   *
   * The sentence is the state's own explanation, so a user who saw the page's notice
   * and a user who hit the refusal read the same account of what happened.
   */
  if (!permitsFork(input.sessionState)) {
    return { status: 409, error: sessionStateExplanation(input.sessionState) };
  }

  /*
   * The resume points — and the two ways they can be absent are separated on
   * purpose, because they are different claims. `unavailable` is "the capture was
   * attempted and failed", `unknown` is "this API was never told". Both are
   * refusals, and neither may be rendered as "there is nothing to resume from",
   * which is what a `captured` empty list would mean.
   */
  if (input.forkPointState !== "captured") {
    return { status: 409, error: forkPointStateExplanation(input.forkPointState) };
  }

  /*
   * The chosen point. The list is non-null here by the table's CHECK, but the check
   * is written as an explicit null test rather than an assertion so a future
   * relaxation of that constraint degrades to a refusal rather than a crash — the
   * same posture `sessions/routes.ts` takes for `data !== null`.
   */
  const points = input.forkPoints ?? [];
  if (!points.some((point) => point.entryId === input.entryId)) {
    return {
      status: 404,
      error: "That is not a resume point of this run's conversation.",
    };
  }

  return null;
}

/**
 * The three shared conditions, in this gesture's words.
 *
 * Exhaustive over `GrillRedoBlock` so adding a condition there is a compile error
 * here — the shared type is what makes "the two gestures apply the same rule"
 * structural rather than a promise.
 */
function resumeBlockRefusal(block: GrillRedoBlock, status: string): string {
  switch (block) {
    case "status":
      return (
        `A grill can only be resumed while the feature is still in Spec, or in a ` +
        `stopped state — this one is ${status}.`
      );
    case "latest_job_kind":
      return "This feature's most recent run is not a grill session.";
    case "active_grill_job":
      return "A grill session is already running for this feature.";
  }
}
