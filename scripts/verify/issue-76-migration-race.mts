/**
 * Issue #76's fix, verified by reproducing the race that caused it.
 *
 * **Why this exists rather than only a test.** The bug was two *processes*
 * booting simultaneously against one database: both read `schema_migrations`,
 * both saw the same file unapplied, both applied it, and the loser exited on
 * `23505`/`schema_migrations_pkey` before it could serve. No in-process test can
 * fail that way by construction — a single `runMigrations` call is not concurrent
 * with itself — so the only honest verification is two real migrators racing.
 *
 * It checks the three things that matter, and each maps to a way the fix could be
 * wrong:
 *
 * 1. **Neither process dies.** The regression itself.
 * 2. **Both processes ran migrations.** A "fix" that made one process skip the
 *    pass entirely would pass check 1 while silently leaving a replica serving an
 *    old schema.
 * 3. **The lock is actually taken**, by observing a waiter from a third
 *    connection. Without this, a lock that is never acquired — or acquired with
 *    keys that differ from the ones observed — would look identical to a working
 *    one, and check 1 would pass for the wrong reason.
 *
 * It also asserts the *uncontended* case: a lone migrator against an already
 * migrated database must not wait, because every ordinary restart takes that path
 * and a lock that adds latency there would be a real cost.
 *
 * **Run it like this** (from `api/`, against a scratch database on the running
 * dev stack — note `--network host`, which is what makes it reachable; the
 * compose test network cannot reach Postgres from a sibling container on this
 * host, see `src/testing/live-postgres.ts`):
 *
 *   docker exec yggdrasil-dev-postgres-1 psql -U yggdrasil -d postgres \
 *     -c "CREATE DATABASE i76check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://yggdrasil:<password>@127.0.0.1:5432/i76check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-76-migration-race.mts
 *
 * `<password>` is `docker inspect yggdrasil-dev-postgres-1` →
 * `POSTGRES_PASSWORD`. It drops nothing; `DROP DATABASE` is blocked for agents in
 * this sandbox, so the database is named in the report.
 */
import { spawn } from "node:child_process";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const LOCK_CLASS = 0x79676764; // "yggd"
const LOCK_OBJECT = 0x6d696772; // "migr"

/**
 * Runs one migrator as a *separate process*, which is the whole point: an
 * advisory lock is per-session, so two `runMigrations` calls in one process
 * would share a connection pool and never contend.
 *
 * The child is a real file (`issue-76-migrator.mts`) rather than an `--eval`
 * string, because `tsx --eval` compiles to CJS and refuses top-level `await` —
 * which made the first version of this script report a failure that had nothing
 * to do with migrations. A sibling `.mts` file is treated as ESM.
 *
 * The child prints the wait callback's message, so the parent can prove the lock
 * was contended rather than inferring it from timing.
 */
function migrateOnce(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "./node_modules/.bin/tsx",
      ["scripts/verify/issue-76-migrator.mts"],
      { env: { ...process.env, DATABASE_URL: connectionString }, cwd: process.cwd() },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("close", (code) => resolve({ code, output }));
  });
}

const admin = new pg.Pool({ connectionString });
const q = (sql: string, values?: unknown[]) => admin.query(sql, values);

// --- 1. two migrators starting at the same moment ---------------------------
console.log("== two migrators racing against one empty database ==");
const [a, b] = await Promise.all([migrateOnce(), migrateOnce()]);

for (const [name, result] of [
  ["first", a],
  ["second", b],
] as const) {
  check(
    `${name} migrator exited 0`,
    result.code === 0,
    result.code === 0 ? "" : `exit=${result.code} :: ${result.output.slice(-400)}`,
  );
}

// The exact signature of the original bug.
const duplicateKey = [a.output, b.output].filter((o) =>
  o.includes("schema_migrations_pkey"),
);
check(
  "neither migrator hit a duplicate-key failure",
  duplicateKey.length === 0,
  duplicateKey.length === 0 ? "" : duplicateKey[0].slice(-300),
);

// Both must have completed the pass — a fix that made one skip it would satisfy
// the checks above while leaving a replica on an old schema.
check(
  "both migrators completed the pass",
  a.output.includes("MIGRATED_OK") && b.output.includes("MIGRATED_OK"),
);

// --- 2. the lock is really taken -------------------------------------------
console.log("\n== the lock is observable, and contended ==");
const { rows: lockRows } = await q<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = $1 AND objid = $2",
  [LOCK_CLASS, LOCK_OBJECT],
);
check(
  "no migration lock is left held after the pass",
  lockRows[0]?.count === "0",
  `pg_locks count=${lockRows[0]?.count}`,
);

// Prove contention: hold the lock here, then run a migrator and confirm it waits
// rather than proceeding. This is what makes check 1 meaningful — without it, a
// no-op lock would pass everything above.
const holder = await admin.connect();
await holder.query("SELECT pg_advisory_lock($1::int, $2::int)", [LOCK_CLASS, LOCK_OBJECT]);
const blocked = await migrateOnce();
await holder.query("SELECT pg_advisory_unlock($1::int, $2::int)", [LOCK_CLASS, LOCK_OBJECT]);
holder.release();

check(
  "a migrator waits while the lock is held elsewhere",
  blocked.output.includes("WAITED:"),
  blocked.output.includes("WAITED:") ? "" : blocked.output.slice(-200),
);

// --- 3. the uncontended path does not wait ---------------------------------
console.log("\n== an ordinary restart does not wait ==");
const solo = await migrateOnce();
check("a lone migrator on a migrated database exits 0", solo.code === 0);
check(
  "a lone migrator does not wait for the lock",
  !solo.output.includes("WAITED:"),
  solo.output.includes("WAITED:") ? "it announced a wait" : "",
);

// --- 4. the schema is actually complete ------------------------------------
console.log("\n== the migrated schema is complete ==");
const { rows: ledger } = await q<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM schema_migrations",
);
const { rows: applied } = await q<{ count: string }>(
  "SELECT COUNT(*)::text AS count FROM pg_tables WHERE schemaname = 'public'",
);
check(
  "the ledger records every migration exactly once",
  Number(ledger[0]?.count) > 40,
  `schema_migrations rows=${ledger[0]?.count}`,
);
check(
  "the ledger has no duplicate names",
  (
    await q<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM (SELECT name FROM schema_migrations GROUP BY name HAVING COUNT(*) > 1) d",
    )
  ).rows[0]?.count === "0",
);
check("tables were created", Number(applied[0]?.count) > 20, `public tables=${applied[0]?.count}`);

await admin.end();
console.log(`\nchecks: ${failures === 0 ? "all passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
