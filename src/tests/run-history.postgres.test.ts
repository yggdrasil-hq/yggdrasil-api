import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { TestRunReportRepository } from "./reports-repository.js";
import { runMigrations } from "../db/migrate.js";
import { JOB_TRIGGER_SOURCES } from "../jobs/types.js";
import { livePostgresSkipWarning, probeLivePostgres } from "../testing/live-postgres.js";

/**
 * Issue #75, verified against a **real Postgres**.
 *
 * Widening a TypeScript union is exactly the kind of fix that can be "verified"
 * by the compiler alone and still be wrong — the original bug *was* a declaration
 * disagreeing with the schema, and TypeScript had no opinion about it. So this
 * inserts a genuinely manual row and reads it back through the repository, which
 * is the only way to show the declaration now describes what the database
 * actually returns.
 *
 * Follows `audit/repository.postgres.test.ts` (issue #61) rather than mocking: a
 * fake pool would agree with the type by construction, which is the mistake that
 * let this ship. The suite's compose file passes `DATABASE_URL`, so this runs for
 * real in CI; where Postgres is unreachable the cases skip with a warning naming
 * what went unverified, and `scripts/verify/issue-75-manual-trigger.mts` is the
 * standalone check.
 */

const connectionString = process.env.DATABASE_URL ?? "";

const reachability = await probeLivePostgres();

if (!reachability.ok) {
  console.warn(
    livePostgresSkipWarning({
      label: "run-history",
      probe: reachability,
      unverified: "the history read, since `trigger_source` allows 'manual' in the schema and the response type did not",

  standalone: "scripts/verify/issue-75-manual-trigger.mts",
    }),
  );
}




describe.skipIf(!reachability.ok)("run history against a real Postgres (issue #75)", () => {
  let pool: pg.Pool;
  let repository: TestRunReportRepository;
  const ids = { user: "", org: "", project: "", test: "" };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    await runMigrations(pool);
    repository = new TestRunReportRepository(pool);

    const stamp = Date.now();
    ids.user = (
      await pool.query(
        `INSERT INTO users (username, display_name, github_id, github_login)
         VALUES ($1, 'I75', $2, $1) RETURNING id`,
        [`i75_${stamp}`, stamp],
      )
    ).rows[0].id;
    ids.org = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ('o75', $1) RETURNING id`,
        [`o75_${stamp}`],
      )
    ).rows[0].id;
    ids.project = (
      await pool.query(
        `INSERT INTO projects (owner_user_id, organization_id, name, slug)
         VALUES ($1, $2, 'p75', $3) RETURNING id`,
        [ids.user, ids.org, `p75_${stamp}`],
      )
    ).rows[0].id;
    ids.test = (
      await pool.query(
        `INSERT INTO tests (project_id, name, spec_markdown, schedule_cron, enabled)
         VALUES ($1, 't75', 'spec', '0 9 * * *', TRUE) RETURNING id`,
        [ids.project],
      )
    ).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    // Scoped deletes rather than a dropped database: the suite's Postgres is
    // shared with other real-Postgres tests in this run, so dropping it would
    // take theirs with it. The project cascade takes the tests and jobs.
    if (pool) {
      if (ids.project) {
        await pool.query("DELETE FROM projects WHERE id = $1", [ids.project]).catch(() => undefined);
      }
      if (ids.org) {
        await pool.query("DELETE FROM organizations WHERE id = $1", [ids.org]).catch(() => undefined);
      }
      if (ids.user) {
        await pool.query("DELETE FROM users WHERE id = $1", [ids.user]).catch(() => undefined);
      }
      await pool.end();
    }
  }, 60_000);

  async function insertRun(triggerSource: string | null): Promise<string> {
    const row = await pool.query(
      `INSERT INTO jobs (project_id, kind, test_id, ref, trigger_source, status)
       VALUES ($1, 'test_run', $2, 'main', $3, 'completed') RETURNING id`,
      [ids.project, ids.test, triggerSource],
    );
    return row.rows[0].id;
  }

  it("accepts every declared trigger source in the schema", async () => {
    // The other direction from the migration test: this proves the *column*
    // accepts what `JOB_TRIGGER_SOURCES` declares, so a value added to the union
    // without a migration fails here rather than at runtime.
    for (const source of JOB_TRIGGER_SOURCES) {
      const jobId = await insertRun(source);
      expect(jobId, `schema rejected ${source}`).toBeTruthy();
    }
  });

  it("returns a manual run with its trigger intact", async () => {
    // The bug, exactly: this value used to be outside the declared response type.
    await insertRun("manual");

    const runs = await repository.listRunsForTest(ids.test, 50);
    const manual = runs.find((run) => run.trigger === "manual");

    expect(manual, "a manual run did not come back with trigger='manual'").toBeDefined();
    // And it is genuinely a member of the declared union, not a cast.
    expect(JOB_TRIGGER_SOURCES).toContain(manual!.trigger);
  });

  it("does not confuse a manual run with a scheduled one", async () => {
    // The distinction migration 049 added the value for: a run a person started
    // must not be attributed to the scheduler in the history that exists to
    // explain why it happened.
    await insertRun("schedule");
    await insertRun("manual");

    const runs = await repository.listRunsForTest(ids.test, 50);
    const triggers = new Set(runs.map((run) => run.trigger));
    expect(triggers.has("manual")).toBe(true);
    expect(triggers.has("schedule")).toBe(true);
  });

  it("still returns null for a job kind with no trigger source", async () => {
    // `null` means "not applicable", which must stay distinct from "a human
    // asked" — the reason 049 rejected reusing NULL for manual runs.
    const row = await pool.query(
      `INSERT INTO jobs (project_id, kind, status) VALUES ($1, 'deploy', 'completed') RETURNING id`,
      [ids.project],
    );
    const job = await pool.query("SELECT trigger_source FROM jobs WHERE id = $1", [
      row.rows[0].id,
    ]);

    expect(job.rows[0].trigger_source).toBeNull();
  });

  it("rejects a trigger source the schema does not allow", async () => {
    // Proves the CHECK is live, so the two passing cases above are not passing
    // because the constraint is absent.
    await expect(insertRun("invented")).rejects.toThrow(/jobs_trigger_source_check/);
  });
});
