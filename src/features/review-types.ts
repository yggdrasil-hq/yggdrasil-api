import type { JobEvent } from "../jobs/events-repository.js";

/**
 * Issue #59: the Agentic Review verdict, as the stage's UI reads it.
 *
 * **Why this is a mapper rather than the raw event.** The event row is a general
 * container — `question`, `markdown`, `prUrl`, `actionItems` and the rest are all
 * nullable fields that mean nothing for a review — and handing it to the Web app
 * would invite the client to depend on whichever column happened to hold the
 * value. The two fields that matter are named here once.
 *
 * **The producer emits prose, not structure.** `agentic_review`'s skill tells the
 * agent to describe each blocking issue *in the free-text `comment`* ("file/location
 * + what's wrong + what the ADR requires"), and the `submit_review` tool carries
 * exactly `{verdict, comment}` — nothing per-location. So `comments` is always
 * empty and `summary` is where the findings actually are. It is a declared empty
 * array rather than an omitted field so a client that renders a list renders an
 * empty one instead of crashing on `undefined`, and the shape is fixed for the day
 * a structured producer exists (filed separately).
 */

/** ADR 015 items 14-16: the only two verdicts, matching the column's CHECK. */
export type AgenticReviewVerdict = "approved" | "changes_requested";

const VERDICTS: readonly string[] = ["approved", "changes_requested"];

/**
 * One place the review pointed at, when the producer can say so.
 *
 * Every field is nullable because a finding may name a file without a line, or
 * neither — and `path: null` with a `body` is a legitimate whole-feature remark,
 * which is a different thing from a missing finding and must stay expressible.
 */
export interface PublicAgenticReviewComment {
  path: string | null;
  line: number | null;
  body: string;
}

export interface PublicAgenticReview {
  /**
   * The terminal verdict, or **null when no verdict is recorded** — either the
   * feature has never been reviewed, or it was reviewed before the verdict was
   * persisted (issue #59's migration note).
   *
   * Null is not "undecided by the reviewer": the UI's job is to render an honest
   * empty state for it, and the alternative — a 404 — is what made "no review"
   * indistinguishable from "the request failed".
   */
  verdict: AgenticReviewVerdict | null;
  /** The reviewer's comment. Where the findings actually are, in prose. */
  summary: string | null;
  /** Always empty today; see this module's note. */
  comments: PublicAgenticReviewComment[];
  /** The `agentic_review` job that produced this verdict, for linking. */
  jobId: string | null;
  /**
   * When the review was decided — the `submit_review` event's own timestamp, not
   * the job's `completed_at`.
   *
   * The event time is the moment the verdict was submitted, which is what "when
   * was this reviewed" means to a reader. The job's completion is a slightly later
   * operational fact (the pod finishing), and it is also the value a crashed job
   * may never have set — so using it would make a recorded verdict look undated.
   */
  completedAt: string | null;
}

/** A verdict the database returned, narrowed to the enum, or null for anything else. */
function narrowVerdict(value: string | null): AgenticReviewVerdict | null {
  // An unrecognised value is treated as "not recorded" rather than passed
  // through: the column has a CHECK constraint, so this is unreachable through
  // the API, and if it ever became reachable the honest answer is that the
  // verdict is not one this client knows how to render.
  return value !== null && VERDICTS.includes(value)
    ? (value as AgenticReviewVerdict)
    : null;
}

/**
 * Maps a stored review event to the read shape, or an empty one when the feature
 * has never been reviewed.
 *
 * `null` in produces a fully-shaped object rather than `null`, so the client has
 * one shape to handle and its `verdict: null` branch is the same branch as a
 * recorded-but-unpersisted verdict. Two ways to say "no verdict" would be one too
 * many for the UI to get right.
 */
export function toPublicAgenticReview(event: JobEvent | null): PublicAgenticReview {
  if (!event) {
    return { verdict: null, summary: null, comments: [], jobId: null, completedAt: null };
  }

  return {
    verdict: narrowVerdict(event.verdict),
    // The `comment` the reviewer wrote is stored in `summary` — the orchestrator
    // maps `comment ?? summary` into that column for this event type
    // (`jobs/internal-routes.ts`), so the generic column name is what carries it.
    summary: event.summary,
    comments: [],
    jobId: event.jobId,
    completedAt: event.createdAt.toISOString(),
  };
}
