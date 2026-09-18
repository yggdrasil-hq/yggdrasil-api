/**
 * Issue #24's per-job delta counter, verified against a real PostgreSQL with
 * every migration applied.
 *
 * **Run it like this** (from `api/`, against a scratch database):
 *
 *   docker exec <postgres-container> psql -U <user> -d postgres -c "CREATE DATABASE i24check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://<user>:<pass>@127.0.0.1:5432/i24check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-24-delta-counter.mts
 *
 * It is committed rather than kept as a scratch file because of the lesson behind
 * it: **a fake pool executes no SQL**, which is how issue #43 — a repository
 * method that raised `42P08 inconsistent types deduced for parameter $2` on every
 * call — sat behind 880 green tests. `recordRelayedDeltaBytes` uses `$2` twice in
 * one statement, which is precisely that failure's shape, and no amount of
 * assertion against a fake would have caught it.
 */
/**
 * Issue #24 verification against a REAL PostgreSQL, with every migration applied.
 *
 * This exists because a fake pool executes nothing: issue #43 was a repository
 * method that raised `42P08 inconsistent types deduced for parameter $2` on every
 * single call, and it sat behind 880 green tests. `recordRelayedDeltaBytes` reuses
 * `$2` twice in one statement, which is exactly that failure's shape — so this
 * runs the real statement against the real server and calls the real repository
 * method, rather than trusting the casts by inspection.
 */
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { JobRepository } from "../../src/jobs/repository.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
const check = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);

await runMigrations(pool);

// --- fixture -----------------------------------------------------------------
const user = (
  await q(
    `insert into users (username, display_name, github_id, github_login)
     values ('i24', 'I24', 424242, 'i24') returning id`,
  )
).rows[0].id;
const org = (
  await q(`insert into organizations (name, slug) values ('i24', 'i24') returning id`)
).rows[0].id;
const project = (
  await q(
    `insert into projects (owner_user_id, organization_id, name, slug)
     values ($1, $2, 'i24', 'i24') returning id`,
    [user, org],
  )
).rows[0].id;
const feature = (
  await q(
    `insert into features (project_id, title, slug, feature_type, status)
     values ($1, 'f', 'f', 'normal', 'running') returning id`,
    [project],
  )
).rows[0].id;

const jobs = new JobRepository(pool);
const featureJob = await jobs.create({ projectId: project, kind: "feature_build", featureId: feature });

// --- 1. the migration and its default ----------------------------------------
const col = await q(
  `select data_type, is_nullable, column_default
   from information_schema.columns
   where table_name = 'jobs' and column_name = 'delta_bytes'`,
);
const col0 = col.rows[0] ?? {};
check(
  "migration 045 adds jobs.delta_bytes NOT NULL DEFAULT 0",
  col0.data_type === "bigint" && col0.is_nullable === "NO" && String(col0.column_default).includes("0"),
  JSON.stringify(col0),
);
check(
  "a pre-existing job reads 0, not NULL",
  (await q(`select delta_bytes from jobs where id = $1`, [featureJob.id])).rows[0].delta_bytes === "0",
);

// --- 2. the real statement, through the real repository method ----------------
// This is the assertion issue #43 would have needed: $2 used twice, executed.
const first = await jobs.recordRelayedDeltaBytes(featureJob.id, 40);
check(
  "recordRelayedDeltaBytes executes (no 42P08 with $2 used twice)",
  first?.totalBytes === 40 && first?.previousBytes === 0,
  JSON.stringify(first),
);
check("  ...and resolves the feature from the job row", first?.featureId === feature, String(first?.featureId));

const second = await jobs.recordRelayedDeltaBytes(featureJob.id, 60);
check(
  "it accumulates rather than overwriting",
  second?.totalBytes === 100 && second?.previousBytes === 40,
  JSON.stringify(second),
);

const dbTotal = (await q(`select delta_bytes from jobs where id = $1`, [featureJob.id])).rows[0].delta_bytes;
check("  ...and the stored column agrees", Number(dbTotal) === 100, String(dbTotal));

// --- 3. bigint comes back as a string, and the repository converts it ---------
const big = await jobs.recordRelayedDeltaBytes(featureJob.id, 8_000_000);
check(
  "bigint is returned as a number, so a `>` comparison is numeric not lexicographic",
  typeof big?.totalBytes === "number" && big!.totalBytes > 8_000_000,
  `${typeof big?.totalBytes} ${big?.totalBytes}`,
);

// --- 4. atomicity under concurrency, which is the reason this is a column -----
const concurrent = await jobs.create({ projectId: project, kind: "feature_build", featureId: feature });
await Promise.all(
  Array.from({ length: 25 }, () => jobs.recordRelayedDeltaBytes(concurrent.id, 10)),
);
const after = (await q(`select delta_bytes from jobs where id = $1`, [concurrent.id])).rows[0].delta_bytes;
check(
  "25 concurrent increments all land (atomic, no lost update)",
  Number(after) === 250,
  `${after} (expected 250)`,
);

// --- 5. a job with no feature still counts, and reports no feature -------------
const bare = await jobs.create({ projectId: project, kind: "deploy" });
const bareRecorded = await jobs.recordRelayedDeltaBytes(bare.id, 5);
check(
  "a job with no feature advances the counter and reports featureId null",
  bareRecorded?.featureId === null && bareRecorded?.totalBytes === 5,
  JSON.stringify(bareRecorded),
);

// --- 6. an unknown job is null, not an error ----------------------------------
check(
  "an unknown job id returns null",
  (await jobs.recordRelayedDeltaBytes("99999999-9999-4999-8999-999999999999", 1)) === null,
);

await pool.end();
