import type { Queryable } from "../db/pool.js";

/**
 * ADR 026: the scheduler's own read/write pair against `tests`.
 *
 * Deliberately narrow — it does not re-expose the Test entity (that is
 * `TestRepository`'s job) and it holds no scheduling logic, because the
 * due-check is cron math and lives, pure and unit-tested, in `cron.ts`. What
 * this owns is the one thing that has to be a database operation: taking a
 * consistent, multi-replica-safe snapshot of the candidate set.
 *
 * Construct it with the client the caller's transaction is already using —
 * that binding is what makes `SKIP LOCKED` mean anything.
 */
export interface DueCandidate {
  testId: string;
  projectId: string;
  scheduleCron: string;
  lastRunAt: Date | null;
  createdAt: Date;
  /**
   * Both flags are already the product's way of saying "this project cannot
   * run a job right now", and each already has an action-queue item behind it
   * (`model_config_warning` from ADR 018's resolution gates,
   * `github_access_warning` from the installation webhooks). Read here purely
   * to skip the dispatch; the scheduler deliberately adds no second warning
   * surface, because a duplicate signal would just be noise to reconcile.
   */
  projectModelConfigWarning: boolean;
  projectGithubAccessWarning: boolean;
  /**
   * Issue #31 part 1: the zone this project's schedule is interpreted in, as a
   * stored IANA name, or `null` when the project has not set one.
   *
   * Passed straight through to `isDueForSchedule`, which resolves an unusable
   * value to UTC rather than throwing — a bad setting must degrade one project,
   * not abort the tick for every project.
   */
  scheduleTimeZone: string | null;
}

interface CandidateRow {
  id: string;
  project_id: string;
  schedule_cron: string;
  last_run_at: Date | null;
  created_at: Date;
  model_config_warning: boolean;
  github_access_warning: boolean;
  schedule_time_zone: string | null;
}

export class TestScheduleRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Every enabled test that *might* be due, longest-since-run first.
   *
   * This is a **superset** by design. SQL cannot evaluate a cron expression
   * held in a column, so the only correct division of labour is: narrow in
   * SQL, decide in TypeScript (`isDueForSchedule`). The `last_run_at < $1`
   * clause is therefore a cheap candidate filter, not the decision — widening
   * it costs a few wasted comparisons, whereas narrowing it would silently
   * skip a run.
   *
   * The project's `settings->>'timezone'` comes along because the due-check needs
   * it and this already joins `projects`; reading it here rather than in a second
   * query per candidate keeps the tick's query count bounded by the candidate
   * set rather than doubling it (issue #31).
   *
   * `FOR UPDATE OF t SKIP LOCKED` is what makes several API replicas safe, by
   * the same precedent as the job queue (ADR 003 §18): the locks are held for
   * the caller's transaction, so a second replica ticking concurrently skips
   * these rows and claims different ones instead of double-dispatching. `OF t`
   * keeps the lock on `tests` only — `projects` is joined to read the warning
   * flags, not to be locked.
   */
  async listCandidates(now: Date, limit: number): Promise<DueCandidate[]> {
    const result = await this.db.query<CandidateRow>(
      `SELECT t.id, t.project_id, t.schedule_cron, t.last_run_at, t.created_at,
              p.model_config_warning, p.github_access_warning,
              p.settings->>'timezone' AS schedule_time_zone
       FROM tests t
       JOIN projects p ON p.id = t.project_id
       WHERE t.enabled = TRUE
         AND (t.last_run_at IS NULL OR t.last_run_at < $1)
       ORDER BY t.last_run_at ASC NULLS FIRST, t.id ASC
       LIMIT $2
       FOR UPDATE OF t SKIP LOCKED`,
      [now, limit],
    );

    return result.rows.map((row) => ({
      testId: row.id,
      projectId: row.project_id,
      scheduleCron: row.schedule_cron,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
      projectModelConfigWarning: row.model_config_warning,
      projectGithubAccessWarning: row.github_access_warning,
      scheduleTimeZone: row.schedule_time_zone,
    }));
  }

  /**
   * Records that this test's schedule fired, and when.
   *
   * `last_run_at` is the scheduler's own bookkeeping — "the last time this
   * schedule dispatched a run" — not "the last time this test ran". A run
   * started for a feature (ADR 015's Testing stage) deliberately does not touch
   * it, since doing so would silently shift the test's schedule. The
   * authoritative "last run of any kind" is the newest entry in the test's run
   * history, which is what the UI shows.
   */
  async markScheduledAt(testId: string, at: Date): Promise<void> {
    await this.db.query(
      `UPDATE tests
       SET last_run_at = $2, updated_at = NOW()
       WHERE id = $1`,
      [testId, at],
    );
  }
}
