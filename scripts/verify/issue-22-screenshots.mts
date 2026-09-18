/**
 * Issue #22's screenshot storage, verified against a real PostgreSQL with every
 * migration applied.
 *
 * **Run it like this** (from `api/`, against a scratch database):
 *
 *   docker exec <postgres-container> psql -U <user> -d postgres -c "CREATE DATABASE i22check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://<user>:<pass>@127.0.0.1:5432/i22check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-22-screenshots.mts
 *
 * Committed rather than kept as a scratch file, for the reason issue #43 taught
 * this repo the hard way: **a fake pool executes no SQL**. `repository.test.ts`
 * pins the shape of each statement, which is what catches a regression in the
 * code; this runs the statements against the database, which is what catches an
 * assumption about the *schema* — a CHECK constraint that does not do what its
 * comment claims, an upsert that duplicates instead of replacing, a purge that
 * deletes instead of tombstoning.
 */
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { JobScreenshotRepository } from "../../src/screenshots/repository.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await runMigrations(pool);

// A real PNG magic-number prefix, so the byte round-trip is of image-shaped data.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);

// --- fixture -----------------------------------------------------------------
const user = (
  await q(
    `insert into users (username, display_name, github_id, github_login)
     values ('i22', 'I22', 222222, 'i22') returning id`,
  )
).rows[0].id;
const org = (
  await q(`insert into organizations (name, slug) values ('i22', 'i22') returning id`)
).rows[0].id;
const project = (
  await q(
    `insert into projects (owner_user_id, organization_id, name, slug)
     values ($1, $2, 'i22', 'i22') returning id`,
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
const job = (
  await q(
    `insert into jobs (project_id, kind, feature_id) values ($1, 'test_run', $2) returning id`,
    [project, feature],
  )
).rows[0].id;

const screenshots = new JobScreenshotRepository(pool);
const day = 24 * 60 * 60 * 1000;
const future = new Date(Date.now() + 30 * day);
const past = new Date(Date.now() - day);

// --- 1. the table's shape -----------------------------------------------------
const cols = await q(
  `select column_name, data_type, is_nullable
     from information_schema.columns where table_name = 'job_screenshots'`,
);
const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));
check(
  "migration 046 creates job_screenshots with the expected columns",
  ["id", "job_id", "project_id", "step_name", "content_type", "byte_size", "data", "expires_at", "purged_at", "created_at"]
    .every((c) => byName[c]),
  Object.keys(byName).join(","),
);
check("  ...with data nullable, so a purge can tombstone", byName.data?.is_nullable === "YES");

// --- 2. the CHECK constraints actually constrain ------------------------------
// Asserted against the database rather than by reading the DDL, because a
// constraint that exists but does not do what its comment claims is worse than
// no constraint: it reads as protection.
async function rejects(label: string, sql: string, values: unknown[]) {
  try {
    await q(sql, values);
    check(label, false, "the statement was accepted");
  } catch {
    check(label, true);
  }
}

await rejects(
  "the content_type CHECK refuses SVG (the stored-XSS format)",
  `insert into job_screenshots (job_id, project_id, step_name, content_type, byte_size, data, expires_at)
   values ($1, $2, 'svg step', 'image/svg+xml', 10, $3, $4)`,
  [job, project, PNG, future],
);
await rejects(
  "  ...and refuses a non-image type at all",
  `insert into job_screenshots (job_id, project_id, step_name, content_type, byte_size, data, expires_at)
   values ($1, $2, 'html step', 'text/html', 10, $3, $4)`,
  [job, project, PNG, future],
);
await rejects(
  "the purge-consistency CHECK refuses a half-purged row (bytes gone, unstamped)",
  `insert into job_screenshots (job_id, project_id, step_name, content_type, byte_size, data, expires_at, purged_at)
   values ($1, $2, 'half', 'image/png', 10, NULL, $3, NULL)`,
  [job, project, future],
);
await rejects(
  "  ...and refuses bytes with a purge stamp",
  `insert into job_screenshots (job_id, project_id, step_name, content_type, byte_size, data, expires_at, purged_at)
   values ($1, $2, 'half2', 'image/png', 10, $3, $4, NOW())`,
  [job, project, PNG, future],
);
await rejects(
  "step_name is refused when empty after trimming",
  `insert into job_screenshots (job_id, project_id, step_name, content_type, byte_size, data, expires_at)
   values ($1, $2, '   ', 'image/png', 10, $3, $4)`,
  [job, project, PNG, future],
);
await rejects(
  "byte_size is refused at zero (an empty artifact is not an artifact)",
  `insert into job_screenshots (job_id, project_id, step_name, content_type, byte_size, data, expires_at)
   values ($1, $2, 'empty', 'image/png', 0, $3, $4)`,
  [job, project, PNG, future],
);

// --- 3. the upsert replaces rather than duplicating ---------------------------
const first = await screenshots.upsert({
  jobId: job,
  projectId: project,
  stepName: "Opens the cart",
  contentType: "image/png",
  data: PNG,
  expiresAt: future,
});
check("upsert stores a screenshot", first.stepName === "Opens the cart" && first.byteSize === PNG.byteLength);

const second = await screenshots.upsert({
  jobId: job,
  projectId: project,
  stepName: "Opens the cart",
  contentType: "image/jpeg",
  data: Buffer.alloc(PNG.byteLength * 2, 3),
  expiresAt: future,
});
const afterRePost = Number((await q(`select count(*)::text as n from job_screenshots where job_id = $1`, [job])).rows[0].n);
check(
  "a re-post of the same step replaces rather than duplicating",
  afterRePost === 1 && second.id === first.id && second.contentType === "image/jpeg",
  `rows=${afterRePost} sameId=${second.id === first.id}`,
);

// A second, different step, to prove the key is per-step and not per-job.
const other = await screenshots.upsert({
  jobId: job,
  projectId: project,
  stepName: "Pays",
  contentType: "image/png",
  data: PNG,
  expiresAt: future,
});
check("a different step gets its own row", other.id !== first.id);

// --- 4. the byte round-trip ---------------------------------------------------
const stored = await screenshots.findContent(job, first.id);
check(
  "the stored bytes round-trip exactly, with the replaced content type",
  stored?.data?.equals(Buffer.alloc(PNG.byteLength * 2, 3)) === true,
  `${stored?.data?.byteLength} bytes, ${stored?.contentType}`,
);

// --- 5. reads never pull bytes for a listing ----------------------------------
const listed = await screenshots.listForJob(job);
check(
  "listForJob returns every step, oldest first",
  listed.length === 2 && listed[0]!.stepName === "Opens the cart",
  listed.map((s) => s.stepName).join(","),
);
check(
  "  ...and carries no bytes",
  !("data" in (listed[0] as unknown as Record<string, unknown>)),
);

// --- 6. countForJob counts tombstones ----------------------------------------
check("countForJob counts distinct steps", (await screenshots.countForJob(job)) === 2);

// --- 7. purge tombstones, keeps rows, and is idempotent -----------------------
await q(`update job_screenshots set expires_at = $2 where id = $1`, [first.id, past]);
const purged = await screenshots.purgeExpired();
check("purgeExpired reclaims the expired artifact", purged === 1, String(purged));

const tombstone = await screenshots.findContent(job, first.id);
check(
  "the purged row survives as a tombstone, so it stays distinguishable from never-captured",
  tombstone !== null && tombstone.data === null && tombstone.purgedAt !== null,
);
const stillUnpurged = await screenshots.findContent(job, other.id);
check("  ...and an unexpired artifact is untouched", stillUnpurged?.data !== null);
check(
  "  ...and the listing still shows both, so the UI can explain the reclaimed one",
  (await screenshots.listForJob(job)).length === 2,
);
check("purgeExpired is idempotent", (await screenshots.purgeExpired()) === 0);
check(
  "  ...and the per-job count still includes the tombstone, so a purge cannot reset quota",
  (await screenshots.countForJob(job)) === 2,
);

// --- 8. re-uploading replaces the tombstone ----------------------------------
const revived = await screenshots.upsert({
  jobId: job,
  projectId: project,
  stepName: "Opens the cart",
  contentType: "image/png",
  data: PNG,
  expiresAt: future,
});
check(
  "re-uploading clears the tombstone (retention raised, artifact re-collected)",
  revived.purgedAt === null && revived.id === first.id,
);
check(
  "  ...and the bytes are readable again",
  (await screenshots.findContent(job, first.id))?.data !== null,
);

// --- 9. the FK cascades with the job -----------------------------------------
await q(`delete from jobs where id = $1`, [job]);
check(
  "deleting the job removes its screenshots",
  Number((await q(`select count(*)::text as n from job_screenshots where job_id = $1`, [job])).rows[0].n) === 0,
);

await pool.end();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
