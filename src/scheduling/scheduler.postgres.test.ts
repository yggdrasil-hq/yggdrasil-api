import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runSchedulerTick } from "./scheduler.js";
import { JobRepository } from "../jobs/repository.js";
import { JobEventRepository } from "../jobs/events-repository.js";
import { relayEnvelopeFor } from "../live/relay.js";
import { runMigrations } from "../db/migrate.js";
import { livePostgresSkipWarning, probeLivePostgres } from "../testing/live-postgres.js";

/**
 * Issue #90's precondition, verified against a **real Postgres** rather than
 * reasoned about.
 *
 * **The question this file exists to answer.** The topic for a scheduled
 * `test_run` routes on `jobs.test_id`. `scheduler.test.ts` already asserts that
 * the tick *passes* `testId` to `JobRepository.create` — but it does so against a
 * fake client that returns a canned row, so it cannot tell whether the INSERT
 * names a column that exists or whether Postgres accepts the statement at all.
 * That is not a hypothetical gap: #43 shipped a repository method that threw on
 * every call and #61 an audit query that 500'd on every request, both behind a
 * green suite, because a fake pool has no opinion on either.
 *
 * So this file runs the **real** tick, over the **real** `JobRepository`, against
 * a migrated database, and then reads the row back. If `test_id` were null in
 * practice — the "declared, marshalled and silently discarded" shape this
 * burn-down has now found six times (#59, #38, #73, #88, #25, #28) — the topic
 * built from it would be correct and *inert*, and nothing but this file would
 * notice.
 *
 * **It follows the row all the way to the topic**, because "the column is
 * populated" and "the relay routes on it" are two claims and the bug lives in the
 * seam between them: scheduler → `jobs` row → `findByIdWithScope` → `topic`.
 *
 * Skipping is loud rather than silent — see `testing/live-postgres.ts`, and note
 * that `scripts/test-against-real-db.sh` is what converts this from a skip into a
 * check.
 */

const connectionString = process.env.DATABASE_URL ?? "";

const reachability = await probeLivePostgres(connectionString);

if (!reachability.ok) {
  console.warn(
    livePostgresSkipWarning({
      label: "scheduler-test-scope",
      probe: reachability,
      unverified:
        "that a scheduled test_run really carries a test_id (not a null), and that " +
        "the relay therefore reaches test:<testId> rather than dropping the event",
    }),
  );
}

describe.skipIf(!reachability.ok)(
  "the scheduler's test_id against a real Postgres (issue #90)",
  () => {
    let pool: pg.Pool;
    let projectId: string;
    let testId: string;

    /**
     * Makes the schedule due and runs one real tick, returning the run it
     * created.
     *
     * The `last_run_at` nudge is not incidental: ADR 026's due-check compares the
     * previous cron occurrence against `last_run_at ?? created_at`, and its
     * reference is never "the epoch" — a test added *now* deliberately waits for
     * its next window rather than firing immediately. A freshly inserted test is
     * therefore never due, so a case that wants a dispatched run has to say the
     * schedule last fired before the window it is claiming.
     *
     * Re-entrant on purpose: it dispatches only when no run exists yet, so these
     * cases do not depend on each other's order.
     */
    async function ensureScheduledRun(): Promise<string> {
      const existing = await pool.query(
        `SELECT id FROM jobs WHERE test_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [testId],
      );
      if (existing.rows[0]) return existing.rows[0].id as string;

      await pool.query(
        `UPDATE tests SET last_run_at = NOW() - interval '1 hour' WHERE id = $1`,
        [testId],
      );
      await runSchedulerTick({ pool, jobs: new JobRepository(pool) }, new Date());

      const created = await pool.query(
        `SELECT id FROM jobs WHERE test_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [testId],
      );
      if (!created.rows[0]) {
        throw new Error(
          "no job exists for this test after a tick. Either the tick dispatched " +
            "nothing, or it dispatched a run whose test_id is null — and both leave " +
            "the relay with no topic, which is the bug this file exists to catch.",
        );
      }
      return created.rows[0].id as string;
    }

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString });
      await runMigrations(pool);

      const stamp = Date.now();
      const userId = (
        await pool.query(
          `INSERT INTO users (username, display_name, github_id, github_login)
           VALUES ($1, 'I90', $2, $1) RETURNING id`,
          [`i90_${stamp}`, stamp],
        )
      ).rows[0].id;

      // An organization is required: `projects.organization_id` is NOT NULL since
      // ADR 016, so a project cannot exist without one.
      const orgId = (
        await pool.query(
          `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
          [`i90-org-${stamp}`],
        )
      ).rows[0].id;

      projectId = (
        await pool.query(
          `INSERT INTO projects (owner_user_id, organization_id, name, slug, status)
           VALUES ($1, $2, 'I90', $3, 'ready') RETURNING id`,
          [userId, orgId, `i90-${stamp}`],
        )
      ).rows[0].id;

      testId = (
        await pool.query(
          `INSERT INTO tests (project_id, name, spec_markdown, schedule_cron)
           VALUES ($1, 'I90 scheduled test', '', '* * * * *') RETURNING id`,
          [projectId],
        )
      ).rows[0].id;
    });

    afterAll(async () => {
      // One statement: `jobs` and `tests` both cascade from the project, so this
      // removes the test file's rows and nothing else. The scratch database is the
      // caller's to drop.
      await pool
        .query("DELETE FROM projects WHERE id = $1", [projectId])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
    });

    it("creates a scheduled run with its test_id populated and no feature", async () => {
      const jobId = await ensureScheduledRun();

      // Read straight from the table rather than trusting a return value: the
      // claim under test is about what Postgres stored.
      const rows = (
        await pool.query(
          `SELECT id, kind, test_id, feature_id, ref, trigger_source, status
           FROM jobs WHERE id = $1`,
          [jobId],
        )
      ).rows;
      expect(rows).toHaveLength(1);

      // The whole point: not null. A null here would make the relay's `test:`
      // branch correct and inert.
      expect(rows[0].test_id).toBe(testId);
      // And no feature, which is *why* the feature branch does not claim it — the
      // two facts together are what send it to the test topic.
      expect(rows[0].feature_id).toBeNull();
      expect(rows[0].kind).toBe("test_run");
      // ADR 026: a schedule verifies the default branch, and `schedule` is what
      // distinguishes it from a manual run in the row.
      expect(rows[0].ref).toBe("main");
      expect(rows[0].trigger_source).toBe("schedule");
    });

    it("routes that job's events to test:<testId>, end to end from the scheduler", async () => {
      // The seam claim. Each step is a separate statement, and the failure this
      // guards is a *missing* column rather than a wrong one: `findByIdWithScope`
      // has its own column list against a join, so a `j.test_id` added to the
      // interface but not to the SELECT would typecheck and return `undefined` at
      // runtime — leaving `relayEnvelopeFor` to fall through to null and the event
      // to reach no socket, which is exactly the bug #90 describes.
      const jobId = await ensureScheduledRun();

      const events = new JobEventRepository(pool);
      // A `report_test_step`, which is one of the two event types a `test_run`
      // actually emits (`jobs/internal-routes.ts`) and therefore a realistic
      // sample of what this topic has to carry.
      const created = await events.create({
        jobId,
        type: "report_test_step",
        status: "passed",
        message: "2 of 5 passing",
      });

      const scoped = await events.findByIdWithScope(created.id);
      expect(scoped?.testId).toBe(testId);
      expect(scoped?.featureId).toBeNull();

      // The topic string a Web client has to build, asserted from the real row.
      const envelope = relayEnvelopeFor(scoped!);
      expect(envelope?.topic).toBe(`test:${testId}`);
      expect(envelope?.frame).toMatchObject({ type: "test_run_event", testId });
    });
  },
);
