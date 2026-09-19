/**
 * Issue #92's read, verified against a real PostgreSQL through the real
 * repositories.
 *
 * **Why this exists rather than only the unit tests.** `jobs/grill-wait.ts` is pure
 * and exhaustively tested, but what it is *given* is not: the events come from
 * `JobEventRepository.listByJob` (real SQL, real `timestamptz` values, a real
 * `ORDER BY created_at ASC`) and the gate comes from
 * `FeatureRepository.findById`. So the questions this answers are the ones the pure
 * tests structurally cannot:
 *
 * - does the age come out right when the question is read back out of Postgres,
 *   rather than out of an object literal a test built?
 * - does a **same-timestamp** question and reply really behave as the tie rule
 *   assumes? That rule exists because `created_at` is the transaction start time
 *   and `listByJob` orders by it alone — an assumption about Postgres, which is
 *   exactly the kind of thing this burn-down has been wrong about before (#86: a
 *   column that could never be written, found only by running the real thing).
 * - does the **latest job's** events really exclude an earlier run's, which is what
 *   makes ADR 024's restart safe without special handling?
 * - do the transitions that clear `awaiting_user_input` actually clear it, so no
 *   stale age survives the wait it describes?
 *
 * **Run it like this** (from `api/`, against a scratch database on the running
 * dev stack — note `--network host`, which is what makes it reachable):
 *
 *   docker exec yggdrasil-dev-postgres-1 psql -U yggdrasil -d postgres \
 *     -c "CREATE DATABASE i92check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://yggdrasil:<password>@127.0.0.1:5432/i92check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-92-grill-wait.mts
 *
 * `<password>` is `docker inspect yggdrasil-dev-postgres-1` → `POSTGRES_PASSWORD`.
 * The scratch database is dropped by `scripts/test-against-real-db.sh` when that
 * wraps this; run directly, it removes only its own rows.
 */
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { JobEventRepository } from "../../src/jobs/events-repository.ts";
import { FeatureRepository } from "../../src/features/repository.ts";
import { deriveAwaitingReply } from "../../src/jobs/grill-wait.ts";
import { resolveGrillReplyTimeout } from "../../src/config.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await runMigrations(pool);

const events = new JobEventRepository(pool);
const features = new FeatureRepository(pool);
const bound = resolveGrillReplyTimeout(undefined);

const stamp = Date.now();
const user = (
  await q(
    `INSERT INTO users (username, display_name, github_id, github_login)
     VALUES ($1, 'I92 verify', $2, $1) RETURNING id`,
    [`i92verify_${stamp}`, stamp],
  )
).rows[0].id;
const org = (
  await q(`INSERT INTO organizations (name, slug) VALUES ('o92v', $1) RETURNING id`, [
    `o92v_${stamp}`,
  ])
).rows[0].id;
const project = (
  await q(
    `INSERT INTO projects (owner_user_id, organization_id, name, slug)
     VALUES ($1, $2, 'p92v', $3) RETURNING id`,
    [user, org, `p92v_${stamp}`],
  )
).rows[0].id;
const feature = (
  await q(
    `INSERT INTO features (project_id, title, slug, status)
     VALUES ($1, 'f92v', $2, 'draft') RETURNING id`,
    [project, `f92v_${stamp}`],
  )
).rows[0].id;

const newJob = async (kind = "spec_grill") =>
  (
    await q(
      `INSERT INTO jobs (project_id, kind, feature_id, status)
       VALUES ($1, $2, $3, 'running') RETURNING id`,
      [project, kind, feature],
    )
  ).rows[0].id as string;

/** Insert an event with an explicit age, so the assertions are about arithmetic. */
const eventAt = async (
  jobId: string,
  type: string,
  secondsAgo: number,
): Promise<void> => {
  await q(
    `INSERT INTO job_events (job_id, type, question, message, created_at)
     VALUES ($1, $2, $3, $4, NOW() - ($5 || ' seconds')::interval)`,
    [
      jobId,
      type,
      type === "ask_user" ? "Which database?" : null,
      type === "user_message" ? "Postgres" : null,
      String(secondsAgo),
    ],
  );
};

/** The route's own composition: the flag from the feature, the events from the job. */
const readAs = async (jobId: string) => {
  const row = (await features.findById(project, feature))!;
  const jobEvents = await events.listByJob(jobId);
  return { awaitingUserInput: row.awaitingUserInput, waiting: deriveAwaitingReply({
    awaitingUserInput: row.awaitingUserInput,
    events: jobEvents,
    timeoutMs: bound.timeoutMs,
    timeoutSource: bound.source,
  }) };
};

// --- the ordinary case ------------------------------------------------------
console.log("\n-- an open question, read back out of Postgres --");
const job = await newJob();
await eventAt(job, "agent_text", 3_700);
await eventAt(job, "ask_user", 3_600);
await q(`UPDATE features SET awaiting_user_input = TRUE WHERE id = $1`, [feature]);

const open = await readAs(job);
check("the flag is visible on the feature read", open.awaitingUserInput === true);
check("an age is reported", open.waiting !== null);
{
  const sinceMs = open.waiting ? Date.parse(open.waiting.since) : NaN;
  const ageMinutes = (Date.now() - sinceMs) / 60_000;
  // An hour, within a minute of tolerance for the round trip: exact equality would
  // assert on `NOW()` agreeing with this process's clock, which is a different
  // claim from "the timestamp survived the read".
  check(
    "and it is the question's own age, not the job's",
    ageMinutes > 59 && ageMinutes < 61,
    `${ageMinutes.toFixed(1)} min (the agent_text beside it is 61 min old)`,
  );
  check(
    "the bound travels with it, as the unset default",
    open.waiting?.timeoutMs === 24 * 60 * 60 * 1000 &&
      open.waiting?.timeoutSource === "default",
  );
}

// --- answered ---------------------------------------------------------------
console.log("\n-- answered --");
await eventAt(job, "user_message", 60);
check(
  "a later reply clears the age even while the flag still says waiting",
  (await readAs(job)).waiting === null,
);

// --- the tie this rule exists for ------------------------------------------
console.log("\n-- a same-timestamp question and reply --");
const tieJob = await newJob();
const tiedAt = new Date(Date.now() - 600_000).toISOString();
await q(
  `INSERT INTO job_events (job_id, type, question, created_at)
   VALUES ($1, 'ask_user', 'Which database?', $2)`,
  [tieJob, tiedAt],
);
await q(
  `INSERT INTO job_events (job_id, type, message, created_at)
   VALUES ($1, 'user_message', 'Postgres', $2)`,
  [tieJob, tiedAt],
);
const tied = await readAs(tieJob);
check(
  "resolves to no age rather than the age of an answered question",
  tied.waiting === null,
);
{
  // And the assumption the rule rests on is stated here rather than believed:
  // the two rows really are indistinguishable by the ordering `listByJob` uses.
  const rows = await events.listByJob(tieJob);
  const times = new Set(rows.map((row) => row.createdAt.getTime()));
  check(
    "the premise holds: Postgres stores them at one indistinguishable instant",
    times.size === 1,
    `${rows.length} rows, ${times.size} distinct created_at`,
  );
}

// --- restart (ADR 024): the latest job's events are the only ones read -------
console.log("\n-- a restarted grill reads its OWN events --");
const restarted = await newJob();
await q(`UPDATE features SET awaiting_user_input = FALSE WHERE id = $1`, [feature]);
const afterRestart = await readAs(restarted);
check(
  "no age from the earlier run's question",
  afterRestart.waiting === null,
);
await eventAt(restarted, "ask_user", 120);
await q(`UPDATE features SET awaiting_user_input = TRUE WHERE id = $1`, [feature]);
{
  const fresh = await readAs(restarted);
  const ageMinutes = fresh.waiting ? (Date.now() - Date.parse(fresh.waiting.since)) / 60_000 : NaN;
  check(
    "and a fresh question starts its own clock",
    ageMinutes > 1.9 && ageMinutes < 2.1,
    `${ageMinutes.toFixed(2)} min`,
  );
}

// --- the transitions that must clear it ------------------------------------
console.log("\n-- a cleared flag leaves no age behind --");
await features.setSpecReady(feature, "# ADR\n\nAccepted.");
check(
  "setSpecReady clears awaiting_user_input on the same row the read gates on",
  (await readAs(restarted)).waiting === null,
);

// --- clean-up ---------------------------------------------------------------
await q("DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE feature_id = $1)", [feature]);
await q("DELETE FROM jobs WHERE feature_id = $1", [feature]);
await q("DELETE FROM features WHERE id = $1", [feature]);
await q("DELETE FROM projects WHERE id = $1", [project]);
await q("DELETE FROM organizations WHERE id = $1", [org]);
await q("DELETE FROM users WHERE id = $1", [user]);
await pool.end();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
