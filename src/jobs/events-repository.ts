import type pg from "pg";
import type { JobKind } from "./types.js";

export type JobEventType =
  | "agent_text"
  | "ask_user"
  | "submit_adr"
  | "run_failed"
  | "run_cancelled"
  | "user_message"
  | "submit_build_result"
  | "run_started"
  | "request_action_item"
  | "submit_review"
  | "report_test_step"
  | "submit_test_report"
  | "update_design_preview"
  | "submit_design"
  /**
   * Issue #27: the Orchestrator synthesized this locally to report that the
   * build's entrypoint resolved conflicts between the feature branch and its
   * base. Context for a reviewer, not a result — see the API's job-event route.
   */
  | "merge_conflicts";

export interface JobEventActionItem {
  type: string;
  description: string;
  secretKey?: string;
  draftTestMarkdown?: string;
}

/**
 * Issue #38: one choice offered by a structured grill question.
 *
 * `description` is optional because it often is — "PostgreSQL" needs no gloss,
 * while "SQLite" is only a real choice once you know it is "simplest for local
 * development". The tool does not require it, so storage must not either.
 */
export interface JobEventQuestionOption {
  label: string;
  description: string | null;
}

/**
 * Issue #38: how a grill question should be *rendered*, when the agent knew the
 * answer was a choice rather than free prose.
 *
 * Null on the containing event means the question is prose — which is both the
 * pre-#38 state of every row and the current state of an open-ended question
 * ("what problem does this solve?"). The issue is explicit that the two modes
 * coexist, and treating "no form" as "prose" rather than as "structured but
 * empty" keeps that in one representation instead of two.
 *
 * `header` is a nullable string even though the tool requires it alongside
 * `options`: see the event schema in `jobs/internal-routes.ts` for why the
 * *requirement* lives there rather than here. Briefly — a renderer can fall back
 * to the question text as a heading, so a missing header is a cosmetic problem,
 * and storing null keeps a malformed payload renderable instead of unreadable.
 */
export interface JobEventQuestionForm {
  header: string | null;
  multiSelect: boolean;
  options: JobEventQuestionOption[];
}

/**
 * Issue #73: one place an agentic review pointed at.
 *
 * `path` and `line` are nullable because a finding may name a file without a line,
 * or neither — and "no location" is a legitimate remark about the change as a whole,
 * which is a different thing from a missing finding and must stay expressible. The
 * read contract (`features/review-types.ts`) types them the same way for the same
 * reason.
 *
 * `blocking` is the field the whole column exists for: it is what makes "N blocking
 * issues" a countable statement instead of a guess, and a `changes_requested`
 * verdict with zero blocking findings is a real (if odd) thing a reviewer can say.
 */
export interface JobEventReviewFinding {
  path: string | null;
  line: number | null;
  body: string;
  blocking: boolean;
}

export interface JobEvent {
  id: string;
  jobId: string;
  type: JobEventType;
  question: string | null;
  markdown: string | null;
  message: string | null;
  status: string | null;
  prUrl: string | null;
  summary: string | null;
  /**
   * Issue #59: the Agentic Review verdict, when this row is a `submit_review`.
   *
   * NULL means **not recorded** rather than "no verdict": the column was added
   * after the event type existed, and every review written before it has no
   * verdict to recover (`db/migrations/051_job_event_verdict.sql`). The read
   * endpoint's `verdict: null` is the same word for the same reason, which is
   * why neither is rendered as a decision of any kind.
   */
  verdict: string | null;
  /**
   * Issue #38: the structured form of an `ask_user` question, or null when it
   * was asked as prose. See `JobEventQuestionForm`.
   */
  questionForm: JobEventQuestionForm | null;
  /**
   * Issue #73: the review's per-location findings, or **null when they were
   * written as prose** in `summary`.
   *
   * Null and `[]` are deliberately different states, and the difference is the
   * whole reason this column exists:
   *
   * - `null` — no structured findings were recorded. Either the review predates
   *   the column, or the reviewer wrote them as a paragraph. A renderer cannot
   *   count blocking issues from this and must not claim zero.
   * - `[]` — structured findings were recorded, and there were none. This is the
   *   only state in which "0 blocking issues" is a true statement.
   *
   * A client that read absence-of-structure as absence-of-problems is what #73
   * describes, so the two must stay distinguishable rather than collapsing to `[]`.
   */
  reviewFindings: JobEventReviewFinding[] | null;
  actionItems: JobEventActionItem[] | null;
  snapshot: Record<string, string> | null;
  createdAt: Date;
}

interface JobEventRow {
  id: string;
  job_id: string;
  type: JobEventType;
  question: string | null;
  markdown: string | null;
  message: string | null;
  status: string | null;
  pr_url: string | null;
  summary: string | null;
  verdict: string | null;
  question_form: JobEventQuestionForm | null;
  review_findings: JobEventReviewFinding[] | null;
  action_items: JobEventActionItem[] | null;
  design_snapshot: Record<string, string> | null;
  created_at: Date;
}

/** A stored event plus the scope its job belongs to, for relay routing. */
interface JobEventScopeRow extends JobEventRow {
  project_id: string;
  feature_id: string | null;
  test_id: string | null;
  kind: JobKind;
}

export interface JobEventWithScope {
  event: JobEvent;
  projectId: string;
  /** Null for a job that belongs to no feature (ADR 014's project-scoped `design_grill`). */
  featureId: string | null;
  /**
   * The owning job's kind, so the relay can route an event for a job with no
   * feature (issue #25).
   *
   * **Why the kind rather than a ready-made topic.** A `featureId` is enough for
   * the feature case because the id *is* the routing key. A design session is the
   * opposite: its session id **is** the job id (see
   * `GET /projects/:projectId/designs/:sessionId/events`, which resolves the
   * session as `findByIdForProject(projectId, sessionId)` and requires
   * `kind === "design_grill"`), so the id alone does not say what it is — the kind
   * does. Passing the kind keeps `relayEnvelopesFor` the one place that decides
   * which topic an event belongs to, which is what its doc comment claims, instead
   * of pushing that decision into SQL as a computed topic column.
   *
   * It is also the field that made the generalisations possible: a feature-less
   * job of another kind was unroutable until `jobKind` travelled with the row —
   * a scheduled `test_run` has no feature either (issue #90), and the design
   * branch needs the kind rather than an id's presence.
   */
  jobKind: JobKind;
  /**
   * The `tests` row a job belongs to, or null (issue #90).
   *
   * **A routing key, like `featureId` and unlike `jobKind`.** A scheduled
   * `test_run` carries a `test_id` and no `feature_id`, and `test_id` names the
   * surface — the standalone Testing product's run history, which reads
   * `GET /projects/:projectId/tests/:testId/runs`. So the id alone is enough for
   * `relayEnvelopesFor` to pick the topic, exactly as a `featureId` is.
   *
   * **A feature-driven `test_run` carries this *and* a `feature_id`** (issue
   * #100): the Testing gate dispatches it for a feature, and it is also one of the
   * runs this Test's history lists, so its events belong to two topics. That is
   * why the relay reads this field even when `featureId` is set — the id's
   * presence is not a tie-break to be skipped, it is a second destination.
   *
   * Only a `test_run` is created with one (`dispatchScheduledRun`, the manual
   * "run now" route and the Testing gate's probe runs all pass `testId`; every
   * other kind leaves it null), but that is a fact about today's callers rather
   * than something this read should enforce — the column is a foreign key and the
   * topic's meaning is "events for this Test", which is true of whatever job
   * carries it.
   */
  testId: string | null;
}

/** The event columns, spelled once so every read returns the same shape. */
const jobEventColumns = `id, job_id, type, question, markdown, message, status, pr_url,
         summary, verdict, question_form, review_findings, action_items, design_snapshot, created_at`;

function mapJobEvent(row: JobEventRow): JobEvent {
  return {
    id: row.id,
    jobId: row.job_id,
    type: row.type,
    question: row.question,
    markdown: row.markdown,
    message: row.message,
    status: row.status,
    prUrl: row.pr_url,
    summary: row.summary,
    verdict: row.verdict,
    questionForm: row.question_form,
    reviewFindings: row.review_findings,
    actionItems: row.action_items,
    snapshot: row.design_snapshot,
    createdAt: row.created_at,
  };
}

/**
 * Persists the curated events the Orchestrator relays from a running job's
 * Pi RPC session (ADR 006 item 8), and serves them back out to the Web app
 * (item 8's original "GET endpoint" follow-up, since landed via
 * `GET /:projectId/features/:featureId/events` in `projects/routes.ts`).
 *
 * Also the relay's write side: `create` announces each row on the `job_events`
 * channel, and the Web app's live socket is fed from that (ADR 019). The Web
 * app still polls `listByJob` — the relay is an accelerator over it, and the
 * poll is what a client falls back to when its socket is down.
 */
export class JobEventRepository {
  constructor(private readonly db: pg.Pool) {}

  async create(input: {
    jobId: string;
    type: JobEventType;
    question?: string;
    markdown?: string;
    message?: string;
    status?: string;
    prUrl?: string;
    summary?: string;
    /**
     * Issue #59: `submit_review`'s verdict. Declared here so it is stored rather
     * than silently dropped.
     *
     * It *was* being dropped, and quietly: the caller spreads the validated
     * payload (`...parsed.data`) into this function, so an undeclared field
     * compiles and is discarded — the transition happened and the record of it
     * did not. Naming it here is what makes the omission a type error next time.
     */
    verdict?: string;
    /**
     * Issue #38: the structured form of an `ask_user` question. Declared here for
     * the reason the `verdict` comment below spells out at length — a caller
     * spreads a wider object into a narrower parameter, so an undeclared field is
     * discarded *silently*. The spread in `jobs/internal-routes.ts` would drop a
     * question form without a type error.
     */
    questionForm?: JobEventQuestionForm | null;
    /**
     * Issue #73: a review's per-location findings. Declared here for the reason the
     * `verdict` and `questionForm` comments give — the caller spreads a wider object
     * into this parameter, so an undeclared field is discarded **silently**. The
     * verdict was already lost that way once (#59), and a findings list lost the
     * same way would leave the column null while the producer believed it had sent
     * structure.
     *
     * `null`/absent means "written as prose"; `[]` means "structured, none found".
     * See the read side's doc comment for why those must stay distinct.
     */
    reviewFindings?: JobEventReviewFinding[] | null;
    actionItems?: JobEventActionItem[];
    snapshot?: Record<string, string>;
  }): Promise<JobEvent> {
    /*
     * **JSONB parameters are serialised explicitly, and that is load-bearing.**
     *
     * `node-postgres` does not send a JS value as JSON: it sends a JS *array* as a
     * Postgres **array literal** (`{...}`) and a plain object as `[...]`-ish text.
     * Postgres then casts the parameter to jsonb, and an array literal is not valid
     * JSON — so a JS array destined for a jsonb column fails at the server with
     * `invalid input syntax for type json`.
     *
     * That is not hypothetical: it was true of `actionItems` from the day the
     * column was added. Every `submit_adr` batch went through this call and could
     * never be stored, and no test noticed because every real-database case here
     * wrote an *object* (`questionForm`) — objects happen to serialise acceptably,
     * so the array path was never executed against a database. Found while adding
     * #73's findings array, whose failing real-database test is what exposed it.
     *
     * `JSON.stringify` for the two array-valued columns; the object-valued ones are
     * left as they are, because changing what already works is a separate risk from
     * fixing what does not. `?? null` is preserved through the stringify so an
     * absent value stays SQL NULL rather than becoming the string "null".
     */
    const result = await this.db.query<JobEventRow>(
      `INSERT INTO job_events
         (job_id, type, question, markdown, message, status, pr_url, summary, verdict, question_form, review_findings, action_items, design_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id, job_id, type, question, markdown, message, status, pr_url,
         summary, verdict, question_form, review_findings, action_items, design_snapshot, created_at`,
      [
        input.jobId,
        input.type,
        input.question ?? null,
        input.markdown ?? null,
        input.message ?? null,
        input.status ?? null,
        input.prUrl ?? null,
        input.summary ?? null,
        input.verdict ?? null,
        input.questionForm ?? null,
        // Explicitly `?? null` rather than defaulting to `[]`: null is "findings were
        // prose" and `[]` is "structured, none found", so collapsing them here would
        // lose the distinction the column exists to carry (issue #73).
        input.reviewFindings ? JSON.stringify(input.reviewFindings) : null,
        input.actionItems ? JSON.stringify(input.actionItems) : null,
        input.snapshot ?? null,
      ],
    );

    // Announces the row to the live relay (ADR 019 item 6), following
    // JobMessageRepository.create's ordering argument verbatim: NOTIFY only
    // becomes visible to a LISTENer once its statement's transaction commits,
    // and pg.Pool.query auto-commits each call, so inserting first is enough —
    // a listener can never be woken for a row it cannot yet read.
    //
    // The payload is the *id*, not the event: pg_notify caps its payload at
    // 8000 bytes and events legitimately carry large markdown, summaries and
    // design snapshots, so the listener reads the row back instead.
    await this.db.query("SELECT pg_notify('job_events', $1)", [result.rows[0].id]);

    return mapJobEvent(result.rows[0]);
  }

  /** Lists a job's events in chronological order. */
  async listByJob(jobId: string): Promise<JobEvent[]> {
    const result = await this.db.query<JobEventRow>(
      `SELECT ${jobEventColumns}
       FROM job_events
       WHERE job_id = $1
       ORDER BY created_at ASC`,
      [jobId],
    );
    return result.rows.map(mapJobEvent);
  }

  /**
   * Loads one event together with the project and feature its job belongs to —
   * the lookup the live relay performs on each notification (ADR 019 item 6).
   *
   * One query rather than two, because the alternative is a notification that
   * carries enough payload to route itself, and NOTIFY's 8000-byte ceiling
   * makes that unsafe for `submit_adr`-sized events. Returns null once the job
   * is gone; the read is best-effort and a deleted job simply has nothing left
   * to deliver.
   */
  async findByIdWithScope(eventId: string): Promise<JobEventWithScope | null> {
    const result = await this.db.query<JobEventScopeRow>(
      `SELECT e.id, e.job_id, e.type, e.question, e.markdown, e.message,
         e.status, e.pr_url, e.summary, e.verdict, e.question_form, e.review_findings,
         e.action_items, e.design_snapshot,
         e.created_at, j.project_id, j.feature_id, j.test_id, j.kind
       FROM job_events e
       INNER JOIN jobs j ON j.id = e.job_id
       WHERE e.id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      event: mapJobEvent(row),
      projectId: row.project_id,
      featureId: row.feature_id,
      jobKind: row.kind,
      testId: row.test_id,
    };
  }

  /** Lists events from a feature's spec_grill runs for kickback context. */
  async listSpecGrillByFeature(featureId: string): Promise<JobEvent[]> {
    const result = await this.db.query<JobEventRow>(
      `SELECT e.id, e.job_id, e.type, e.question, e.markdown, e.message,
         e.status, e.pr_url, e.summary, e.verdict, e.question_form, e.review_findings,
         e.action_items, e.design_snapshot,
         e.created_at
       FROM job_events e
       INNER JOIN jobs j ON j.id = e.job_id
       WHERE j.feature_id = $1 AND j.kind = 'spec_grill'
       ORDER BY e.created_at ASC`,
      [featureId],
    );
    return result.rows.map(mapJobEvent);
  }

  /**
   * Issue #59: a feature's most recent Agentic Review verdict, or null when the
   * feature has never been reviewed.
   *
   * **Joined through `jobs` rather than filtered on the feature directly**, because
   * `job_events` has no `feature_id` — the event knows only its job, and the job
   * knows its feature. A subquery on `jobs` would be the same query with an extra
   * plan node; the join is what lets the `idx_job_events_reviews` partial index
   * (migration 051) supply the ordering.
   *
   * **The most recent review, not the reviews of the most recent review job.**
   * Those are the same row in practice and different questions in principle: a
   * feature is returned, rebuilt and reviewed again, so "the current verdict" is
   * the newest `submit_review` the feature has, whichever run produced it. Asking
   * per-job would need the feature's *latest* `agentic_review` job first — an
   * extra query, and a worse answer if that job crashed before submitting, since
   * it would then report "no review" over an older verdict that is still the last
   * thing anyone decided.
   *
   * `ORDER BY e.created_at DESC` with no tiebreak beyond it is deliberate but
   * worth naming: two reviews of one feature in the same millisecond would be
   * ordered arbitrarily. That is not reachable — a review is a whole agent run,
   * and the second cannot start until the first has finished and the feature has
   * moved back to `implementation` — so a deterministic tiebreak would be
   * machinery for a case that cannot occur.
   */
  async findLatestReviewByFeature(featureId: string): Promise<JobEvent | null> {
    const result = await this.db.query<JobEventRow>(
      // Qualified columns, not the shared `jobEventColumns` constant: those are
      // unqualified, and this is a join against `jobs`, which has its own `id`
      // and `created_at`. Reusing the constant here is exactly how issue #61's
      // audit query became ambiguous against the joined `projects` table — the
      // constant is only safe in a single-table read.
      `SELECT e.id, e.job_id, e.type, e.question, e.markdown, e.message,
         e.status, e.pr_url, e.summary, e.verdict, e.question_form, e.review_findings,
         e.action_items, e.design_snapshot, e.created_at
       FROM job_events e
       INNER JOIN jobs j ON j.id = e.job_id
       WHERE j.feature_id = $1 AND e.type = 'submit_review'
       ORDER BY e.created_at DESC
       LIMIT 1`,
      [featureId],
    );
    return result.rows[0] ? mapJobEvent(result.rows[0]) : null;
  }
}
