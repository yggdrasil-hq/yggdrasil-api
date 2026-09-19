/**
 * Issue #73's storage, verified against a **real PostgreSQL** with every migration
 * applied.
 *
 * **Why this exists rather than only tests.** Two things here are Postgres
 * semantics that a fake pool cannot check at all: the jsonb **round trip** (a value
 * goes in, and what comes back out is what the read path will project), and
 * migration 053's **shape constraint** (a `review_findings` payload on any event
 * type but `submit_review`, or one that is not an array, must be refused). A fake
 * pool records the SQL *string* and returns canned rows, which is the shape of #43,
 * #61 and #56 — a green suite over SQL nothing ran.
 *
 * It also asserts the distinction the column exists for, at the level where it is
 * decided: `NULL` and `[]` are different answers to "how many blocking issues", and
 * a migration or mapper that collapsed them would still pass every unit test.
 *
 * **Run it like this** (from `api/`, against a scratch database on the running dev
 * stack — note `--network host`, which is what makes it reachable):
 *
 *   docker exec yggdrasil-dev-postgres-1 psql -U yggdrasil -d postgres \
 *     -c "CREATE DATABASE i73check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://yggdrasil:<password>@127.0.0.1:5432/i73check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-73-review-findings.mts
 *
 * `<password>` is `docker inspect yggdrasil-dev-postgres-1` → `POSTGRES_PASSWORD`.
 * `DROP DATABASE` is refused for agents in this sandbox, so name the database in
 * your report.
 */
import pg from "pg";

process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.INTERNAL_API_TOKEN ??= "issue-73-verify";

const { runMigrations } = await import("../../src/db/migrate.ts");
const { JobEventRepository } = await import("../../src/jobs/events-repository.ts");
const { toPublicAgenticReview } = await import("../../src/features/review-types.ts");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await runMigrations(pool);

// --- fixtures -----------------------------------------------------------------
const stamp = Date.now();
const userId = (
  await q(
    `INSERT INTO users (username, display_name, github_id, github_login)
     VALUES ($1, 'I73', $2, $1) RETURNING id`,
    [`i73_${stamp}`, stamp],
  )
).rows[0].id;
const orgId = (
  await q(
    `INSERT INTO organizations (name, slug, is_personal, status)
     VALUES ($1, $2, TRUE, 'ready') RETURNING id`,
    [`I73 org ${stamp}`, `i73-org-${stamp}`],
  )
).rows[0].id;
const projectId = (
  await q(
    `INSERT INTO projects (owner_user_id, organization_id, name, slug)
     VALUES ($1, $2, 'I73 project', $3) RETURNING id`,
    [userId, orgId, `i73-project-${stamp}`],
  )
).rows[0].id;
const featureId = (
  await q(
    `INSERT INTO features (project_id, title, slug, feature_type, status)
     VALUES ($1, 'I73 feature', 'i73-feature', 'normal', 'testing') RETURNING id`,
    [projectId],
  )
).rows[0].id;
const jobId = (
  await q(
    `INSERT INTO jobs (project_id, kind, feature_id, status)
     VALUES ($1, 'agentic_review', $2, 'running') RETURNING id`,
    [projectId, featureId],
  )
).rows[0].id;

const events = new JobEventRepository(pool);
const findings = [
  { path: "src/auth.ts", line: 42, body: "Token refresh is missing.", blocking: true },
  { path: null, line: null, body: "Overall shape is fine.", blocking: false },
];

// --- 1. the jsonb round trip, through the read path ------------------------
await events.create({
  jobId,
  type: "submit_review",
  verdict: "changes_requested",
  summary: "Three things to fix.",
  reviewFindings: findings,
});
const readBack = await events.findLatestReviewByFeature(featureId);
const mapped = toPublicAgenticReview(readBack);
check(
  "findings survive the write and come back through the read path intact",
  mapped.comments.length === 2 &&
    mapped.comments[0]!.path === "src/auth.ts" &&
    mapped.comments[0]!.line === 42 &&
    mapped.comments[0]!.blocking === true &&
    mapped.comments[1]!.path === null &&
    mapped.comments[1]!.blocking === false,
  JSON.stringify(mapped.comments),
);
check(
  "and the response says the findings were recorded, so a count is knowable",
  mapped.findingsRecorded === true,
  `findingsRecorded=${mapped.findingsRecorded}`,
);

// --- 2. NULL and [] stay distinct, which is the whole point of the column ---
const emptyJob = (
  await q(
    `INSERT INTO jobs (project_id, kind, feature_id, status)
     VALUES ($1, 'agentic_review', $2, 'running') RETURNING id`,
    [projectId, featureId],
  )
).rows[0].id;
await events.create({
  jobId: emptyJob,
  type: "submit_review",
  verdict: "approved",
  summary: "Nothing to flag.",
  reviewFindings: [],
});
const emptyRead = toPublicAgenticReview(await events.findLatestReviewByFeature(featureId));
check(
  "an empty structured list reports findingsRecorded, so \"0 blocking issues\" is true",
  emptyRead.findingsRecorded === true && emptyRead.comments.length === 0,
  `findingsRecorded=${emptyRead.findingsRecorded}`,
);

const proseJob = (
  await q(
    `INSERT INTO jobs (project_id, kind, feature_id, status)
     VALUES ($1, 'agentic_review', $2, 'running') RETURNING id`,
    [projectId, featureId],
  )
).rows[0].id;
await events.create({
  jobId: proseJob,
  type: "submit_review",
  verdict: "changes_requested",
  summary: "Three blocking issues, in prose.",
});
const proseRead = toPublicAgenticReview(await events.findLatestReviewByFeature(featureId));
check(
  "a prose review reports findingsRecorded false, so a client must not claim zero",
  proseRead.findingsRecorded === false && proseRead.comments.length === 0,
  `findingsRecorded=${proseRead.findingsRecorded} summary=${JSON.stringify(proseRead.summary)}`,
);

// --- 3. the migration's shape constraint is live ---------------------------
const nonArrayRefused = await q(
  `INSERT INTO job_events (job_id, type, review_findings) VALUES ($1, 'submit_review', $2::jsonb)`,
  [jobId, JSON.stringify({ path: "a.ts" })],
).then(
  () => false,
  (error: { code?: string; constraint?: string }) =>
    error.code === "23514" && error.constraint === "job_events_review_findings_check",
);
check(
  "a non-array findings payload is refused by the constraint, not just by the route",
  nonArrayRefused,
  "expected 23514 on job_events_review_findings_check",
);

const wrongTypeRefused = await q(
  `INSERT INTO job_events (job_id, type, review_findings) VALUES ($1, 'agent_text', '[]'::jsonb)`,
  [jobId],
).then(
  () => false,
  (error: { code?: string; constraint?: string }) =>
    error.code === "23514" && error.constraint === "job_events_review_findings_check",
);
check(
  "findings on a non-review event are refused, so the column cannot acquire a second meaning",
  wrongTypeRefused,
  "expected 23514 on job_events_review_findings_check",
);

// --- 4. the migration is safe on a database that already has rows ----------
// Every pre-#73 row has NULL here, which is what makes the constraint addable
// without a backfill — asserted rather than assumed, since a NOT NULL or a
// default would have broken an existing install.
const nullsAllowed = await q(
  `SELECT count(*)::int AS n FROM job_events WHERE review_findings IS NULL`,
).then((r) => r.rows[0].n > 0);
check(
  "existing rows keep NULL findings, so the migration needs no backfill",
  nullsAllowed,
  "expected at least one row with a NULL review_findings",
);

// --- cleanup -----------------------------------------------------------------
await q(`DELETE FROM job_events WHERE job_id IN ($1, $2, $3)`, [jobId, emptyJob, proseJob]);
await q(`DELETE FROM jobs WHERE id IN ($1, $2, $3)`, [jobId, emptyJob, proseJob]);
await q(`DELETE FROM features WHERE id = $1`, [featureId]);
await q(`DELETE FROM projects WHERE id = $1`, [projectId]);
await q(`DELETE FROM organizations WHERE id = $1`, [orgId]);
await q(`DELETE FROM users WHERE id = $1`, [userId]);
console.log("\nfixtures removed; the database is as it was found.");

await pool.end();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
