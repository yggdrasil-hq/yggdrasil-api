/**
 * Issue #28 part 2's read, verified against a real PostgreSQL with every migration
 * applied.
 *
 * **Why this exists alongside `src/jobs/repository.postgres.test.ts`.** That file
 * runs the same query inside the suite, which is the primary verification. This is
 * the standalone half, for the reason the convention exists: the defect this query
 * can suffer is *only* visible to Postgres.
 *
 * The query is a **join**, and `jobs`/`job_events` share `id`, `status` and
 * `created_at`. Selecting unqualified columns over it raises `42702 ambiguous` —
 * the exact defect that made every audit read 500 (`buildAuditWhere`, issue #61).
 * **TypeScript cannot see it**: `jobColumns` is a well-typed string, and a wrong SQL
 * statement type-checks perfectly because the row type is a promise the compiler
 * takes on faith. So the only thing that can tell you the statement is valid is
 * executing it.
 *
 * It checks four things a compiler and a fake pool both cannot:
 *
 * - the statement is **accepted** (the ambiguity guard);
 * - ordering is by `created_at`, not insertion order, which is what makes the last
 *   element the current run;
 * - the supersession lookup resolves through `restarted_from_event_id` to the job
 *   containing that event;
 * - a job whose rewound-from event was deleted still comes back, with no link —
 *   the `ON DELETE SET NULL` behaviour behind migration 037.
 *
 * **Run it like this** (from `api/`, against a scratch database on the running dev
 * stack — `--network host` is what makes it reachable; see
 * `src/testing/live-postgres.ts` for why the compose network is not):
 *
 *   docker exec yggdrasil-dev-postgres-1 psql -U yggdrasil -d postgres \
 *     -c "CREATE DATABASE i28check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://yggdrasil:<password>@127.0.0.1:5432/i28check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-28-grill-runs.mts
 *
 * `<password>` is `docker inspect yggdrasil-dev-postgres-1` → `POSTGRES_PASSWORD`.
 * It removes the rows it creates; `DROP DATABASE` is blocked for agents in this
 * sandbox, so name the database in your report.
 */
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { JobRepository } from "../../src/jobs/repository.ts";
import { earlierGrillRuns } from "../../src/jobs/grill-runs.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await runMigrations(pool);
const repository = new JobRepository(pool);

const stamp = Date.now();
const created: string[] = [];

const user = (
  await q(
    `INSERT INTO users (username, display_name, github_id, github_login)
     VALUES ($1, 'I28', $2, $1) RETURNING id`,
    [`i28v_${stamp}`, stamp],
  )
).rows[0].id;
const org = (
  await q(`INSERT INTO organizations (name, slug) VALUES ('o28v', $1) RETURNING id`, [
    `o28v_${stamp}`,
  ])
).rows[0].id;
const project = (
  await q(
    `INSERT INTO projects (owner_user_id, organization_id, name, slug)
     VALUES ($1, $2, 'p28v', $3) RETURNING id`,
    [user, org, `p28v_${stamp}`],
  )
).rows[0].id;
created.push(user, org, project);

const feature = (
  await q(
    `INSERT INTO features (project_id, title, slug, feature_type, status)
     VALUES ($1, 'verified', $2, 'normal', 'draft') RETURNING id`,
    [project, `f28v_${stamp}`],
  )
).rows[0].id;

const job = async (createdAt: string, restartedFromEventId: string | null = null) =>
  (
    await q(
      `INSERT INTO jobs (project_id, kind, feature_id, status, created_at, restarted_from_event_id)
       VALUES ($1, 'spec_grill', $2, 'completed', $3, $4) RETURNING id`,
      [project, feature, createdAt, restartedFromEventId],
    )
  ).rows[0].id as string;

// Inserted out of chronological order on purpose, so an implementation relying on
// insertion order rather than `created_at` is caught rather than accidentally right.
const third = await job("2026-09-03T00:00:00Z");
const first = await job("2026-09-01T00:00:00Z");
const anchor = (
  await q(
    `INSERT INTO job_events (job_id, type, created_at) VALUES ($1, 'agent_text', $2) RETURNING id`,
    [first, "2026-09-01T00:05:00Z"],
  )
).rows[0].id as string;
const second = await job("2026-09-02T00:00:00Z", anchor);

// 1. The ambiguity guard. This is the assertion that matters most: an unqualified
//    column list passes TypeScript and every fake, and fails only here.
let runs: Awaited<ReturnType<typeof repository.listFeatureGrillRuns>> = [];
try {
  runs = await repository.listFeatureGrillRuns(feature);
  check("the join is accepted by Postgres (no ambiguous column)", true);
} catch (error) {
  check(
    "the join is accepted by Postgres (no ambiguous column)",
    false,
    error instanceof Error ? error.message : String(error),
  );
}

// 2. Ordering by created_at, not insertion order.
check(
  "orders by created_at ascending, not by insertion order",
  runs.map((r) => r.jobId).join(",") === [first, second, third].join(","),
  runs.map((r) => r.jobId.slice(0, 8)).join(" "),
);

// 3. The supersession lookup resolves through the event to the job holding it.
const secondRun = runs.find((r) => r.jobId === second);
check(
  "resolves which run a rewind superseded, through the event's own job",
  secondRun?.supersedesJobId === first && secondRun?.restartedFromEventId === anchor,
  `supersedesJobId=${secondRun?.supersedesJobId?.slice(0, 8)} expected ${first.slice(0, 8)}`,
);

// 4. The rule layer, over the real rows: the last run is current and excluded.
const earlier = earlierGrillRuns(runs);
check(
  "offers every run except the current one, newest first",
  earlier.map((r) => r.jobId).join(",") === [second, first].join(","),
);
check(
  "links the superseded run to the run that rewound it",
  earlier.find((r) => r.jobId === first)?.supersededByJobId === second,
);

// 5. `ON DELETE SET NULL`: a job outlives the event it rewound from, and losing the
//    link must not lose the run — a user came here to read that transcript.
await q("DELETE FROM job_events WHERE id = $1", [anchor]);
/*
 * Wrapped, unlike the checks above, so a failure here does not abort the script
 * before it prints a summary. The first check already reports the query itself
 * being rejected; if that happened, every later check fails for the same reason,
 * and a stack trace instead of a summary reads as "the script broke" rather than
 * "the query is invalid".
 */
try {
  const afterDelete = await repository.listFeatureGrillRuns(feature);
  check(
    "keeps a run whose rewound-from event was deleted, with the link cleared",
    afterDelete.length === runs.length &&
      afterDelete.find((r) => r.jobId === second)?.restartedFromEventId === null &&
      afterDelete.find((r) => r.jobId === second)?.supersedesJobId === null,
  );
} catch (error) {
  check(
    "keeps a run whose rewound-from event was deleted, with the link cleared",
    false,
    error instanceof Error ? error.message : String(error),
  );
}

// Cleanup. Scoped, so a neighbouring scratch database is untouched.
await q("DELETE FROM projects WHERE id = $1", [project]);
await q("DELETE FROM organizations WHERE id = $1", [org]);
await q("DELETE FROM users WHERE id = $1", [user]);
await pool.end();

console.log("");
console.log(failures === 0 ? "all checks passed" : `${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
