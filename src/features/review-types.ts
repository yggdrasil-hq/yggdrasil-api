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
 * **The producer now emits structure when it can (issue #73).** `submit_review`
 * carries an optional `findings` array, stored as jsonb on the event, and this
 * mapper projects it onto `comments`. The prose path is unchanged and still the
 * common one: the skill writes a paragraph unless the reviewer records per-location
 * findings, so `summary` remains where the findings are for most reviews.
 *
 * **`comments: []` is now a claim, so it is only emitted when it is true.** Before
 * #73 the array was always empty because nothing could fill it, and a client that
 * read that as "no findings" was reading absence-of-structure as
 * absence-of-problems — which is the defect. So the two states are distinguished by
 * what the *storage* says: `reviewFindings === null` (prose, or pre-#73) projects to
 * `[]` **with `findingsRecorded: false`**, while `[]` (structured, none found)
 * projects to `[]` with `findingsRecorded: true`. A client can therefore tell the two
 * apart without guessing, and the Web app's `reviewDetail` already branches on
 * exactly that distinction.
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
  /**
   * Whether this finding blocks the review (issue #73).
   *
   * Always present on the wire even though the producer may omit it, because a
   * client counting blockers must not have to decide what an absent flag means. The
   * default is applied at ingest, matching the read contract's own default.
   */
  blocking: boolean;
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
  /** The reviewer's comment. Where the findings are, when they are prose. */
  summary: string | null;
  /**
   * Per-location findings, empty when there are none **or** when they were written
   * as prose — `findingsRecorded` is what distinguishes those.
   *
   * An array rather than a nullable field, because a client rendering a list should
   * render an empty one rather than crash on `undefined`; the honest signal is
   * `findingsRecorded`, not the array's emptiness.
   */
  comments: PublicAgenticReviewComment[];
  /**
   * Whether the producer recorded *structured* findings for this review.
   *
   * - `false` — the findings are prose in `summary` (or this review predates the
   *   column). A blocking count is **not knowable** and a client must not assert
   *   zero.
   * - `true` — `comments` is authoritative, and counting its `blocking` entries is
   *   a true statement about the review.
   *
   * This is the field that makes "0 blocking issues" safe to render or not. Without
   * it, an empty `comments` array is ambiguous between "nothing was found" and "the
   * findings were written as a paragraph", which is precisely what let a panel
   * contradict itself over a `changes_requested` review.
   */
  findingsRecorded: boolean;
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
    return {
      verdict: null,
      summary: null,
      comments: [],
      // No event at all is not "structured with nothing found" — there is no review
      // to count, so the honest answer is that no findings were recorded.
      findingsRecorded: false,
      jobId: null,
      completedAt: null,
    };
  }

  return {
    verdict: narrowVerdict(event.verdict),
    // The `comment` the reviewer wrote is stored in `summary` — the orchestrator
    // maps `comment ?? summary` into that column for this event type
    // (`jobs/internal-routes.ts`), so the generic column name is what carries it.
    summary: event.summary,
    comments: (event.reviewFindings ?? []).map((finding) => ({
      path: finding.path,
      line: finding.line,
      body: finding.body,
      blocking: finding.blocking,
    })),
    // The distinction the storage draws, passed through rather than inferred from
    // `comments.length` — see the field's doc comment.
    findingsRecorded: event.reviewFindings !== null,
    jobId: event.jobId,
    completedAt: event.createdAt.toISOString(),
  };
}
