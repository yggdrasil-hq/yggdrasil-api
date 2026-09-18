/**
 * Issue #63's fix, verified against a real PostgreSQL with every migration
 * applied.
 *
 * **Why this exists rather than only tests.** Two parts of this change are SQL,
 * and this repository's habit of asserting SQL as a *string* against a fake pool
 * is precisely how #43 (a method that raised on every call) and #61 (a query that
 * was ambiguous on every call) shipped behind green suites. The two statements
 * worth running are:
 *
 * - `FeatureRepository.listTestingAwaitingDecision`, whose whole point is that it
 *   now **includes features with no runs at all** — the case the old `EXISTS`
 *   requirement made unreachable, and therefore the case that left a feature
 *   wedged in `testing` forever once probes stopped being dispatched;
 * - `JobKindCapabilityRepository.unrunnable`, whose freshness comparison is a
 *   `timestamptz` predicate that only Postgres can confirm.
 *
 * It also walks the whole loop once, which is the claim that matters: a feature
 * in `testing` with no runs, on an installation that cannot run the script
 * groups, **advances** rather than sitting there.
 *
 * **Run it like this** (from `api/`, against a scratch database on the running
 * dev stack — note `--network host`, which is what makes it reachable):
 *
 *   docker exec yggdrasil-dev-postgres-1 psql -U yggdrasil -d postgres \
 *     -c "CREATE DATABASE i63check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://yggdrasil:<password>@127.0.0.1:5432/i63check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-63-capabilities.mts
 *
 * `<password>` is `docker inspect yggdrasil-dev-postgres-1` →
 * `POSTGRES_PASSWORD`. Clean-up removes the rows it created; `DROP DATABASE` is
 * blocked for agents in this sandbox, so drop the database yourself afterwards.
 */
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { FeatureRepository } from "../../src/features/repository.ts";
import { ProjectRepository } from "../../src/projects/repository.ts";
import { JobRepository } from "../../src/jobs/repository.ts";
import { TestRepository } from "../../src/tests/repository.ts";
import { TestRunReportRepository } from "../../src/tests/reports-repository.ts";
import { JobKindCapabilityRepository } from "../../src/jobs/capabilities.ts";
import { runTestingGateTick } from "../../src/features/testing-gate-reconcile.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await runMigrations(pool);

// --- seed ------------------------------------------------------------------
const suffix = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;
const githubId = Number(`${Date.now() % 10_000_000}${process.pid % 1000}`);

const org = (
  await q(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`, [
    `i63 ${suffix}`,
    `i63-${suffix}`,
  ])
).rows[0]!.id;
const actor = (
  await q(
    `INSERT INTO users (username, display_name, github_id, github_login)
     VALUES ($1,$2,$3,$1) RETURNING id`,
    [`i63-${suffix}`, "i63", githubId],
  )
).rows[0]!.id;
// `agentic_review_enabled` so a pass has somewhere to go and the advance is
// observable as a status change plus a dispatched job.
const project = (
  await q(
    `INSERT INTO projects (owner_user_id, organization_id, name, slug, status, agentic_review_enabled)
     VALUES ($1,$2,$3,$4,'ready',TRUE) RETURNING id`,
    [actor, org, "i63 project", `i63-${suffix}`],
  )
).rows[0]!.id;

const newFeature = async (name: string, status: string): Promise<string> =>
  (
    await q(
      `INSERT INTO features (project_id, title, slug, feature_type, status)
       VALUES ($1,$2,$3,'normal',$4) RETURNING id`,
      [project, name, `${name}-${suffix}`, status],
    )
  ).rows[0]!.id;

// The wedge case: in `testing`, and no run exists or can exist.
const noRuns = await newFeature("no runs", "testing");
// A feature whose probes are still in flight must NOT be offered.
const inFlight = await newFeature("in flight", "testing");
await q(
  `INSERT INTO jobs (project_id, kind, feature_id, status) VALUES ($1,'script_test_run',$2,'running')`,
  [project, inFlight],
);
console.log(`seeded project=${project} noRuns=${noRuns} inFlight=${inFlight}\n`);

// --- 1. the pre-filter now reaches the empty-run case ---------------------
console.log("--- the tick's candidate query (the wedge fix) ---");
{
  const features = new FeatureRepository(pool);
  const candidates = await features.listTestingAwaitingDecision(50);
  const ids = candidates.map((c) => c.id);

  check(
    "a feature in `testing` with no runs at all is offered",
    ids.includes(noRuns),
    "before #63 the EXISTS clause excluded exactly this",
  );
  check(
    "a feature with a run still in flight is not offered",
    !ids.includes(inFlight),
  );
  check("and the project id comes back with it", candidates.every((c) => Boolean(c.projectId)));
}

// --- 2. the capability reader, including expiry ---------------------------
console.log("\n--- capability reporting, and its expiry ---");
{
  await q(
    `INSERT INTO job_kind_capabilities (job_kind, runnable, reported_at)
     VALUES ('script_test_run', FALSE, NOW())
     ON CONFLICT (job_kind) DO UPDATE SET runnable = FALSE, reported_at = NOW()`,
  );
  const reader = new JobKindCapabilityRepository(pool);
  check("a fresh negative claim is read", (await reader.unrunnable()).has("script_test_run"));

  await q(
    `UPDATE job_kind_capabilities SET reported_at = NOW() - interval '2 hours'
      WHERE job_kind = 'script_test_run'`,
  );
  check(
    "an expired claim is ignored, so a fixed install recovers",
    !(await reader.unrunnable()).has("script_test_run"),
  );

  // Unsigned: a stale claim reverts to "unknown", which the caller treats as
  // capable — i.e. dispatch resumes.
  await q(
    `INSERT INTO job_kind_capabilities (job_kind, runnable, reported_at)
     VALUES ('script_test_run', FALSE, NOW())
     ON CONFLICT (job_kind) DO UPDATE SET runnable = FALSE, reported_at = NOW()`,
  );
}

// --- 3. the whole loop: does the feature actually advance? ----------------
console.log("\n--- the loop: a `testing` feature with nothing to verify ---");
{
  const deps = {
    pool,
    features: new FeatureRepository(pool),
    jobs: new JobRepository(pool),
    projects: new ProjectRepository(pool),
    testRunReports: new TestRunReportRepository(pool),
    tests: new TestRepository(pool),
    capabilities: new JobKindCapabilityRepository(pool),
  };

  const tick = await runTestingGateTick(deps);
  check("the tick applied a decision", tick.applied >= 1, JSON.stringify(tick));

  const after = (
    await q(`SELECT status FROM features WHERE id = $1`, [noRuns])
  ).rows[0]!.status;
  check(
    "the zero-run feature advanced rather than sitting in `testing` forever",
    after === "agentic_review",
    `status=${after}`,
  );

  const reviewJob = await q(
    `SELECT id FROM jobs WHERE feature_id = $1 AND kind = 'agentic_review'`,
    [noRuns],
  );
  check("and a review job was dispatched behind it", reviewJob.rowCount === 1);

  // A second tick must be a no-op — the decision moved the feature out of
  // `testing`, which is what makes this safe with several replicas.
  const second = await runTestingGateTick(deps);
  check("a second tick applies nothing", second.applied === 0, JSON.stringify(second));
}

// --- 4. unknown capabilities must NOT advance (the safe default) ----------
console.log("\n--- the default: an installation that has not reported ---");
{
  const unverified = await newFeature("unknown capabilities", "testing");
  await q(`DELETE FROM job_kind_capabilities WHERE job_kind = 'script_test_run'`);

  const deps = {
    pool,
    features: new FeatureRepository(pool),
    jobs: new JobRepository(pool),
    projects: new ProjectRepository(pool),
    testRunReports: new TestRunReportRepository(pool),
    tests: new TestRepository(pool),
    capabilities: new JobKindCapabilityRepository(pool),
  };
  const tick = await runTestingGateTick(deps);

  const after = (await q(`SELECT status FROM features WHERE id = $1`, [unverified])).rows[0]!
    .status;
  check(
    "a feature waits rather than advancing on an unreported capability",
    after === "testing" && tick.applied === 0,
    `status=${after} applied=${tick.applied}`,
  );
  // The distinction, stated as a check: the same feature advances once the
  // installation reports it cannot run the group, and not before.
  await q(
    `INSERT INTO job_kind_capabilities (job_kind, runnable, reported_at)
     VALUES ('script_test_run', FALSE, NOW())
     ON CONFLICT (job_kind) DO UPDATE SET runnable = FALSE, reported_at = NOW()`,
  );
  await runTestingGateTick(deps);
  const reported = (await q(`SELECT status FROM features WHERE id = $1`, [unverified])).rows[0]!
    .status;
  check("and advances once it does report", reported === "agentic_review", `status=${reported}`);
}

// --- clean up --------------------------------------------------------------
await q(`DELETE FROM job_kind_capabilities WHERE job_kind = 'script_test_run'`);
await q(`DELETE FROM jobs WHERE project_id = $1`, [project]);
await q(`DELETE FROM features WHERE project_id = $1`, [project]);
await q(`DELETE FROM projects WHERE id = $1`, [project]);
await q(`DELETE FROM users WHERE id = $1`, [actor]);
await q(`DELETE FROM organizations WHERE id = $1`, [org]);
console.log("\ncleaned up the seeded rows");

await pool.end();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
