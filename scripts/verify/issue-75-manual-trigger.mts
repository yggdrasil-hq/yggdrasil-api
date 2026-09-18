/**
 * Issue #75's fix, verified against a real PostgreSQL with every migration
 * applied.
 *
 * **Why this exists rather than only tests.** The bug was a *declaration*
 * disagreeing with the schema, and TypeScript had no opinion about it: the value
 * travelled from a `pg` row typed by assertion, so nothing forced `run-history.ts`
 * to agree with `jobs.trigger_source`'s CHECK. A widened union compiles
 * regardless of what the column accepts, so the only honest verification is to
 * insert rows the schema and the type both claim are possible and read them back.
 *
 * It checks three things a compiler cannot:
 *
 * - the column **accepts** every value the union declares (so a value added to
 *   the union without a migration fails here, rather than at runtime);
 * - a manual run is **returned** with `trigger === "manual"` through the real
 *   history read, which is the exact path that used to hand back a value its own
 *   response type said could not occur;
 * - the CHECK is **live**, so the cases above are not passing because the
 *   constraint is missing.
 *
 * **Run it like this** (from `api/`, against a scratch database on the running
 * dev stack — note `--network host`, which is what makes it reachable):
 *
 *   docker exec yggdrasil-dev-postgres-1 psql -U yggdrasil -d postgres \
 *     -c "CREATE DATABASE i75check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://yggdrasil:<password>@127.0.0.1:5432/i75check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-75-manual-trigger.mts
 *
 * `<password>` is `docker inspect yggdrasil-dev-postgres-1` →
 * `POSTGRES_PASSWORD`. It removes the rows it creates; `DROP DATABASE` is blocked
 * for agents in this sandbox, so name the database in your report.
 */
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { TestRunReportRepository } from "../../src/tests/reports-repository.ts";
import { JOB_TRIGGER_SOURCES } from "../../src/jobs/types.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await runMigrations(pool);

// --- seed ------------------------------------------------------------------
const stamp = Date.now();
const user = (
  await q(
    `INSERT INTO users (username, display_name, github_id, github_login)
     VALUES ($1, 'I75 verify', $2, $1) RETURNING id`,
    [`i75verify_${stamp}`, stamp],
  )
).rows[0].id;
const org = (
  await q(`INSERT INTO organizations (name, slug) VALUES ('o75v', $1) RETURNING id`, [
    `o75v_${stamp}`,
  ])
).rows[0].id;
const project = (
  await q(
    `INSERT INTO projects (owner_user_id, organization_id, name, slug)
     VALUES ($1, $2, 'p75v', $3) RETURNING id`,
    [user, org, `p75v_${stamp}`],
  )
).rows[0].id;
const test = (
  await q(
    `INSERT INTO tests (project_id, name, spec_markdown, schedule_cron, enabled)
     VALUES ($1, 't75v', 'spec', '0 9 * * *', TRUE) RETURNING id`,
    [project],
  )
).rows[0].id;

const insertRun = async (triggerSource: string | null) =>
  (
    await q(
      `INSERT INTO jobs (project_id, kind, test_id, ref, trigger_source, status)
       VALUES ($1, 'test_run', $2, 'main', $3, 'completed') RETURNING id`,
      [project, test, triggerSource],
    )
  ).rows[0].id as string;

// --- 1. the column accepts everything the union declares -------------------
console.log("\n-- schema accepts the declared union --");
for (const source of JOB_TRIGGER_SOURCES) {
  let ok = true;
  let detail = "";
  try {
    await insertRun(source);
  } catch (error) {
    ok = false;
    detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }
  check(`inserts trigger_source='${source}'`, ok, detail);
}

// --- 2. the CHECK is live --------------------------------------------------
console.log("\n-- the CHECK is actually enforced --");
let rejected = false;
let rejectDetail = "";
try {
  await insertRun("invented");
} catch (error) {
  rejected = true;
  rejectDetail = error instanceof Error ? error.message.split("\n")[0] : String(error);
}
check(
  "rejects a value outside the union",
  rejected && rejectDetail.includes("jobs_trigger_source_check"),
  rejectDetail,
);

// --- 3. the real history read returns it intact ----------------------------
console.log("\n-- the history read returns what the type declares --");
await insertRun("schedule");
await insertRun("manual");

const repository = new TestRunReportRepository(pool);
const runs = await repository.listRunsForTest(test, 50);
const triggers = runs.map((run) => run.trigger);

check("history includes 'manual'", triggers.includes("manual"), `saw ${JSON.stringify(triggers)}`);
check("history includes 'schedule'", triggers.includes("schedule"));
check(
  "every returned trigger is in the declared union (or null)",
  triggers.every((trigger) => trigger === null || (JOB_TRIGGER_SOURCES as readonly string[]).includes(trigger)),
);

const manualRun = runs.find((run) => run.trigger === "manual");
check("the manual run is identifiable as such", manualRun !== undefined);
check(
  "and carries the public entry shape a client reads",
  manualRun !== undefined &&
    typeof manualRun.jobId === "string" &&
    typeof manualRun.testId === "string",
);

// --- 4. null still means "not applicable" ----------------------------------
console.log("\n-- null still means 'not applicable', not 'a human asked' --");
const deployJob = (
  await q(
    `INSERT INTO jobs (project_id, kind, status) VALUES ($1, 'deploy', 'completed') RETURNING id`,
    [project],
  )
).rows[0].id;
const deployTrigger = (await q("SELECT trigger_source FROM jobs WHERE id = $1", [deployJob]))
  .rows[0].trigger_source;
check("a deploy job's trigger_source is NULL", deployTrigger === null);

// --- clean-up --------------------------------------------------------------
// Deletes rather than a dropped database: an agent cannot `DROP DATABASE` here,
// and leaving the rows would pollute the scratch database for the next run.
await q("DELETE FROM projects WHERE id = $1", [project]);
await q("DELETE FROM organizations WHERE id = $1", [org]);
await q("DELETE FROM users WHERE id = $1", [user]);
await pool.end();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
