/**
 * ADR 032: the session-specific half of artifact retention, plus the outcome
 * vocabulary that ADR 032 item 5 is about.
 *
 * The generic rules — the expiry boundary, the inclusive size cap, the
 * human-readable sizes — are *not* reimplemented here; they come from
 * `shared/artifacts.ts` for the same reason `recordings/retention.ts` and
 * `screenshots/retention.ts` take them from there: retention has two places where
 * a silent off-by-one is invisible (the expiry instant, where the sweeper's SQL
 * and the read path must agree, and `>` versus `>=` at the cap), and two copies
 * are two chances for a purge and a read to disagree.
 *
 * What is genuinely this feature's own is the **outcome vocabulary** and the state
 * it maps to, and that is where the interesting decision in this module is.
 */

import { exceedsSizeCap, formatByteSize } from "../shared/artifacts.js";

export { formatRetention, resolveExpiry } from "../shared/artifacts.js";

/**
 * The three outcomes ADR 032 item 5 requires a user to be able to tell apart.
 *
 * The strings are the Orchestrator's own wire values verbatim
 * (`worker.SessionCollectionOutcome`), deliberately, so neither service needs a
 * mapping table and a log line on either side is readable without a lookup.
 *
 * **`disabled` is not one of them.** It exists in the Orchestrator's vocabulary
 * but is never posted — it is a fact about the installation rather than the run,
 * and a deployment with collection switched off would otherwise write a per-run
 * row saying nothing about any run. So it surfaces here as *no row at all*, which
 * is what `sessionState` turns into `unknown`. See the migration for the full
 * reasoning.
 */
export const SESSION_OUTCOMES = ["collected", "not_collected", "unavailable"] as const;
export type SessionOutcome = (typeof SESSION_OUTCOMES)[number];

/** Whether a value posted as `?outcome=` is one this API accepts. */
export function isSessionOutcome(value: string): value is SessionOutcome {
  return (SESSION_OUTCOMES as readonly string[]).includes(value);
}

/**
 * What a session is, as far as anything reading it is concerned.
 *
 * **Five states, and deliberately not the shared three-state `ArtifactState`.**
 * That is a real divergence and it is the whole of item 5, so it is worth stating
 * rather than assuming: `ArtifactState` models `available | expired |
 * never_recorded`, and item 5 requires the two *failing* cases to stay apart —
 * "this run never produced a session" (a fact about the run) against "this run's
 * session could not be retrieved" (a fact about the retrieval, and the only one
 * worth an operator looking at). Those two are exactly what `never_recorded`
 * collapses, and collapsing them is not a cosmetic loss: it makes a transient
 * upload failure indistinguishable from a run that never got far enough to have a
 * session, which is the "looks finished, does nothing" shape this suite keeps
 * finding.
 *
 * `unknown` is the fifth and is not stored anywhere — it is what *no row* means.
 * It is separated from `not_collected` because they are different claims: a
 * `not_collected` row is the Orchestrator saying "Pi answered and there was no
 * session", whereas no row says only that this API was never told anything. A
 * deployment with collection switched off produces the second and never the first,
 * and the UI must not describe it as the run's fault.
 */
export type SessionState =
  /** Bytes present and not expired: a fork is possible. */
  | "available"
  /** Bytes were stored but have been reclaimed, or are past their window. */
  | "expired"
  /** Pi produced no session for this run. A fact about the run. */
  | "not_collected"
  /** A session may exist; this run could not obtain it. Not the run's fault. */
  | "unavailable"
  /** This API was never told anything about the run's session. */
  | "unknown";

/** The facts a stored session row contributes to its state. */
export interface SessionFacts {
  outcome: SessionOutcome;
  /** Present iff the bytes are still readable from wherever they live. */
  hasData: boolean;
  expiresAt: Date | null;
  purgedAt: Date | null;
}

/**
 * The state of a stored session, as of `now`.
 *
 * Takes the row's own facts rather than a repository row so it is exercisable
 * without a database, and takes `now` as an argument so a caller cannot read the
 * clock twice inside one decision — both following `artifactState`.
 *
 * The order of the checks is load-bearing. **The outcome is consulted before the
 * bytes**, so a `not_collected` row can never be reported as `available` even if a
 * future code path were to store bytes against one — the table's CHECK makes that
 * unwritable, and this stays honest if the constraint is ever relaxed. And a
 * tombstone outranks a live timestamp: a reclaimed artifact is expired whatever its
 * clock says, because the bytes are what the caller came for.
 */
export function sessionState(facts: SessionFacts, now: Date): SessionState {
  if (facts.outcome !== "collected") return facts.outcome;
  if (!facts.hasData || facts.purgedAt !== null) return "expired";
  if (facts.expiresAt !== null && facts.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "available";
}

/** The state for a job this API holds no session row for at all. */
export const UNKNOWN_SESSION_STATE: SessionState = "unknown";

/**
 * The availability of a session **as a stored row implies it**, or `unknown` when
 * there is no row.
 *
 * Exported so the read route and the resume route cannot disagree about whether a
 * run's session can be forked. That is not a hypothetical: the resume control is
 * offered on the strength of `canFork` in the read response, so if the dispatch
 * route computed availability its own way the two could disagree and the page would
 * offer a control the API then refuses — the user-visible form of the "two copies of
 * one rule" bug this file keeps warning about.
 *
 * **`hasData` follows the read route's notion, not the content route's.** A
 * `collected` row whose object has gone missing from the bucket reads as
 * `available` here and 404s at the content route; that split is deliberate (this
 * route reports what was *recorded*, that one what can be *fetched*). For a fork it
 * matters in the right direction: such a session is refused downstream as a
 * `write`-stage failure — the stage that exists for exactly "the artifact never
 * reached the pod" — rather than as an API refusal the page has no control for.
 */
export function storedSessionState(
  session: {
    outcome: SessionOutcome;
    expiresAt: Date | null;
    purgedAt: Date | null;
  } | null,
  now: Date,
): SessionState {
  if (!session) return UNKNOWN_SESSION_STATE;
  return sessionState(
    {
      outcome: session.outcome,
      hasData: session.outcome === "collected",
      expiresAt: session.expiresAt,
      purgedAt: session.purgedAt,
    },
    now,
  );
}

/**
 * Whether this state means a true fork can be attempted against the stored
 * session.
 *
 * Exported as the one predicate for it, mirroring the Orchestrator's
 * `SessionCollectionOutcome.CollectsSession` — the two halves must agree about
 * which outcomes permit a fork, and stating it once on each side is what keeps
 * that agreement checkable. Note that this is *necessary and not sufficient*: a
 * fork also needs an entry id, which is a fact `get_fork_messages` has and this
 * API does not yet capture (issue #28's follow-up).
 */
export function permitsFork(state: SessionState): boolean {
  return state === "available";
}

/** The media type the Orchestrator posts a session as (`PostJobSession`). */
export const SESSION_CONTENT_TYPE = "application/x-ndjson";

/**
 * The two things `get_fork_messages` can have happened to it (ADR 032 item 2).
 *
 * The strings are the Orchestrator's own wire values verbatim
 * (`worker.ForkPointOutcome`), deliberately, so neither service needs a mapping
 * table — the same rule `SESSION_OUTCOMES` follows.
 *
 * Note that **an unanswered question is not a failure of the run**, which is why
 * these are not the session's three outcomes: a session is `collected` or one of
 * two kinds of no, whereas this question was either answered or not. "This run has
 * no fork points" is not an outcome here — it is `captured` with an empty list.
 */
export const FORK_POINT_OUTCOMES = ["captured", "unavailable"] as const;
export type ForkPointOutcome = (typeof FORK_POINT_OUTCOMES)[number];

/** Whether a value posted as a fork-points outcome is one this API accepts. */
export function isForkPointOutcome(value: string): value is ForkPointOutcome {
  return (FORK_POINT_OUTCOMES as readonly string[]).includes(value);
}

/**
 * What this API knows about a run's fork points — the stored outcome, or `unknown`
 * for a run it was never told anything about.
 *
 * **Three states, and the third is the one that matters.** `captured` with an
 * empty list and `unavailable` are different facts (Pi said there are none; nobody
 * found out), and `unknown` is a third — this API holds no record at all, which is
 * what an install with session collection switched off produces and what a capture
 * that never reached the API leaves behind. Folding any two of them together would
 * tell a user "there is nothing to resume from" on the strength of a question that
 * was never asked, which is the collapse ADR 032 item 5 exists to prevent.
 */
export type ForkPointState = ForkPointOutcome | "unknown";

/** The state for a job this API holds no fork-points row for at all. */
export const UNKNOWN_FORK_POINT_STATE: ForkPointState = "unknown";

/**
 * Why a fork-point capture was refused, or null when it is acceptable.
 *
 * The outcomes take opposite bodies and the table's CHECK enforces it, so this
 * exists to give the Orchestrator a *reason* it can log rather than a constraint
 * violation it cannot read — the same posture as `rejectSessionUpload`, which the
 * Orchestrator also treats as "log it and finish the job normally".
 *
 * An empty list is explicitly **acceptable** for `captured`: it is Pi saying this
 * session has no previous user messages to fork from, which a real Pi 0.84.4 does
 * answer with `{"messages":[]}`. Refusing it would be refusing a fact because it
 * was inconvenient, and it would push the caller towards not reporting at all —
 * which loses the distinction the state exists for.
 */
export function rejectForkPointUpload(input: {
  outcome: ForkPointOutcome;
  pointCount: number;
}): string | null {
  if (input.outcome === "captured") return null;
  if (input.pointCount > 0) {
    return `An outcome of "${input.outcome}" cannot carry fork points`;
  }
  return null;
}

/**
 * Why a session upload was refused, or null when it is acceptable.
 *
 * Returned as a reason rather than thrown, because the Orchestrator treats every
 * refusal the same way: it logs it and finishes the job normally (ADR 029's rule
 * for recordings, which ADR 032 item 1 follows — an artifact must never fail a
 * run).
 *
 * **The outcome has to agree with the body, and this is not pedantry.** A
 * `collected` outcome with an empty body would store a row claiming a fork is
 * possible over no bytes, and a failing outcome *with* a body would store bytes
 * the outcome says do not exist. The table's CHECK cannot see this — it constrains
 * one row, and the contradiction is between two of its columns — so it is caught
 * here, where the caller gets a reason it can log.
 *
 * A non-positive `maxBytes` means collection is switched off and refuses every
 * upload. That is the honest reading of item 4's "zero means reclaim everything":
 * nothing new is stored, and the sweep reclaims what exists.
 */
export function rejectSessionUpload(input: {
  outcome: SessionOutcome;
  byteSize: number;
  maxBytes: number;
}): string | null {
  if (input.maxBytes <= 0) {
    return "Session collection is switched off";
  }
  if (input.outcome === "collected") {
    if (input.byteSize <= 0) {
      return "A collected session arrived with an empty body";
    }
    if (exceedsSizeCap(input.byteSize, input.maxBytes)) {
      return `Session exceeds the ${formatByteSize(input.maxBytes)} limit (${formatByteSize(input.byteSize)})`;
    }
    return null;
  }
  // The three failing outcomes. `disabled` never reaches here (it is never
  // posted); `not_collected` and `unavailable` both mean "no artifact", and both
  // must carry an empty body.
  if (input.byteSize > 0) {
    return `An outcome of "${input.outcome}" cannot carry a session body`;
  }
  return null;
}
