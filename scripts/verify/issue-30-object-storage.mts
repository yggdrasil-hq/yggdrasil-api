/**
 * Issue #30's object-storage migration, verified against a real PostgreSQL with
 * every migration applied and against a real MinIO.
 *
 * **Why this exists rather than only tests.** `repository.test.ts` for the three
 * repositories pins the *shape* of each statement with a fake pool, which is what
 * catches a regression in the code — and a fake pool executes no SQL, which is
 * how issue #43 (a repository method that raised `42P08` on every call) sat
 * behind 880 green tests. This runs the statements and the signing against the
 * real services, which is what catches an assumption about the schema (a CHECK
 * constraint that does not do what its comment claims) and an assumption about
 * the signature (a hand-rolled signer the server disagrees with).
 *
 * The in-suite contract tests in `src/storage/client.test.ts` cover the same
 * client, but they skip when storage is unreachable — and in some sandboxes the
 * container network cannot route between compose services at all, so they skip
 * there and this is what actually verifies the client. It is committed rather
 * than left as a scratch file so the next person can re-run it.
 *
 * **Run it like this** (from `api/`, against a scratch database and the running
 * dev stack's MinIO — note `--network host`, which is what makes both reachable):
 *
 *   docker exec <postgres-container> psql -U <user> -d postgres -c "CREATE DATABASE i30check;"
 *   MINIO_IP=$(docker inspect <minio-container> --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://<user>:<pass>@127.0.0.1:5432/i30check" \
 *     -e S3_ENDPOINT="http://$MINIO_IP:9000" \
 *     -e S3_ACCESS_KEY="<minio-user>" -e S3_SECRET_KEY="<minio-pass>" \
 *     -e S3_BUCKET="i30check" -e S3_FORCE_PATH_STYLE=true \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-30-object-storage.mts
 */
import crypto from "node:crypto";
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { S3ObjectStorage, createObjectStorage } from "../../src/storage/client.ts";
import { backfillObjects } from "../../src/storage/backfill.ts";
import { recordingKey } from "../../src/storage/keys.ts";
import { JobRecordingRepository } from "../../src/recordings/repository.ts";
import { JobScreenshotRepository } from "../../src/screenshots/repository.ts";
import { OrgExtensionRepository } from "../../src/extensions/repository.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
/** A constraint violation is the expected outcome; anything else is a surprise. */
async function expectRejected(label: string, run: () => Promise<unknown>) {
  try {
    await run();
    check(label, false, "the write was accepted");
  } catch (error) {
    const code = (error as { code?: string }).code;
    check(label, code === "23514" || code === "23502", `rejected with ${code ?? String(error)}`);
  }
}

await runMigrations(pool);

const storage = createObjectStorage({
  endpoint: process.env.S3_ENDPOINT ?? "",
  accessKeyId: process.env.S3_ACCESS_KEY ?? "",
  secretAccessKey: process.env.S3_SECRET_KEY ?? "",
  bucket: process.env.S3_BUCKET ?? "",
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
});
if (!storage) {
  console.error("S3_* must be set: this script verifies object storage, not Postgres.");
  process.exit(1);
}
await storage.ensureBucket();

// --- fixture -----------------------------------------------------------------
const user = (
  await q(
    `insert into users (username, display_name, github_id, github_login)
     values ('i30', 'I30', 303030, 'i30') returning id`,
  )
).rows[0].id;
const org = (
  await q(
    `insert into organizations (name, slug) values ('I30', 'i30') returning id`,
  )
).rows[0].id;
const project = (
  await q(
    `insert into projects (owner_user_id, organization_id, name, slug)
     values ($1, $2, 'I30', 'i30') returning id`,
    [user, org],
  )
).rows[0].id;
const job = (
  await q(
    `insert into jobs (project_id, kind) values ($1, 'test_run') returning id`,
    [project],
  )
).rows[0].id;

/** A real WebM magic-number prefix, so the bytes are media-shaped rather than text. */
const WEBM = Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  crypto.randomBytes(64),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  crypto.randomBytes(64),
]);

// --- 1. the migration's own invariants ---------------------------------------
console.log("\n--- migration 047: the storage columns and their constraint ---");

const recordingColumns = await q(
  `SELECT column_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_name = 'job_recordings' AND column_name IN ('storage_backend', 'object_key')
    ORDER BY column_name`,
);
check(
  "job_recordings gained storage_backend (NOT NULL default postgres) and object_key",
  recordingColumns.rows.length === 2 &&
    recordingColumns.rows[0]!.column_name === "object_key" &&
    recordingColumns.rows[1]!.column_name === "storage_backend" &&
    recordingColumns.rows[1]!.is_nullable === "NO" &&
    String(recordingColumns.rows[1]!.column_default).includes("postgres"),
  JSON.stringify(recordingColumns.rows),
);
check(
  "org_extension_files.content became nullable",
  (
    await q(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'org_extension_files' AND column_name = 'content'`,
    )
  ).rows[0]!.is_nullable === "YES",
);

/*
 * The three states, which is the part of this migration most worth checking
 * against the database rather than trusting: a constraint that silently permits
 * "bytes in both places" would let a future code path produce a row that reads
 * inconsistently depending on which branch it took.
 */
console.log("\n--- the three states are exhaustive ---");
const insertRecording = (data: Buffer | null, key: string | null, backend: string, purge: boolean) =>
  q(
    `insert into job_recordings
       (job_id, project_id, content_type, byte_size, data, expires_at, purged_at,
        storage_backend, object_key)
     values ($1, $2, 'video/webm', 68, $3, NOW() + interval '30 days', $4, $5, $6)`,
    [job, project, data, purge ? new Date() : null, backend, key],
  );

await expectRejected("rejects bytes in the database *and* an object key", () =>
  insertRecording(WEBM, "recordings/x.webm", "postgres", false),
);
await expectRejected("rejects object backend with no key", () =>
  insertRecording(null, null, "object", false),
);
await expectRejected("rejects a tombstone still holding database bytes", () =>
  insertRecording(WEBM, null, "postgres", true),
);
await expectRejected("rejects an unknown backend", () =>
  insertRecording(null, "k", "s3-ish", false),
);

// Live Postgres-backed row: the pre-existing state, which must still be writable.
await insertRecording(WEBM, null, "postgres", false);
check("accepts a live Postgres-backed row", true);
await q(`delete from job_recordings where job_id = $1`, [job]);

// --- 2. Postgres backend: no regression -------------------------------------
console.log("\n--- Postgres backend, unchanged behaviour ---");
const noStorageRecordings = new JobRecordingRepository(pool);
await noStorageRecordings.upsert({
  jobId: job,
  projectId: project,
  contentType: "video/webm",
  data: WEBM,
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
});
const pgRow = (
  await q(
    `SELECT storage_backend, object_key, octet_length(data) as size FROM job_recordings WHERE job_id = $1`,
    [job],
  )
).rows[0];
check(
  "a recording written with no storage configured keeps its bytes in the column",
  pgRow.storage_backend === "postgres" && pgRow.object_key === null && pgRow.size === WEBM.byteLength,
  JSON.stringify(pgRow),
);
const pgContent = await noStorageRecordings.findContent(job);
check("and reads back byte-identical", pgContent?.data?.equals(WEBM) === true);

// --- 3. object backend: write, read, purge ----------------------------------
console.log("\n--- object backend: write, read, purge ---");
const objectRecordings = new JobRecordingRepository(pool, storage);
await objectRecordings.upsert({
  jobId: job,
  projectId: project,
  contentType: "video/webm",
  data: WEBM,
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
});
const objectRow = (
  await q(
    `SELECT storage_backend, object_key, data FROM job_recordings WHERE job_id = $1`,
    [job],
  )
).rows[0];
check(
  "the row records object storage and holds no bytes",
  objectRow.storage_backend === "object" && objectRow.object_key !== null && objectRow.data === null,
  JSON.stringify({ backend: objectRow.storage_backend, key: objectRow.object_key }),
);
const expectedKey = recordingKey({
  projectId: project,
  jobId: job,
  contentType: "video/webm",
});
check("the key is the one the key builder derives", objectRow.object_key === expectedKey);
check(
  "the object is actually in the bucket, byte-identical",
  (await storage.getObject(expectedKey))?.equals(WEBM) === true,
);
const objectContent = await objectRecordings.findContent(job);
check("findContent fetches it back through the client", objectContent?.data?.equals(WEBM) === true);
check(
  "metadata reads never touch the bytes",
  (await objectRecordings.findByJob(job))?.byteSize === WEBM.byteLength,
);

// Purge: the sweep must find an object-backed row, because its bytes are not in
// `data`. This is the half that a careless change would miss, leaving every
// object-backed artifact unreclaimable while all the Postgres tests still passed.
await q(`update job_recordings set expires_at = NOW() - interval '1 day' where job_id = $1`, [job]);
const purged = await objectRecordings.purgeExpired();
const purgedRow = (
  await q(
    `SELECT purged_at, object_key FROM job_recordings WHERE job_id = $1`,
    [job],
  )
).rows[0];
check("the sweep reclaims an object-backed row", purged === 1, `purged=${purged}`);
check("the object is gone from the bucket", (await storage.getObject(expectedKey)) === null);
check(
  "the row survives as a tombstone and keeps the key",
  purgedRow.purged_at !== null && purgedRow.object_key === expectedKey,
);

// --- 4. screenshots ---------------------------------------------------------
console.log("\n--- screenshots, both backends ---");
const screenshots = new JobScreenshotRepository(pool, storage);
const stored = await screenshots.upsert({
  jobId: job,
  projectId: project,
  stepName: "Opens the cart / reopens it",
  contentType: "image/png",
  data: PNG,
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
});
check("a screenshot uploads to the bucket", stored.id !== undefined);
const shotContent = await screenshots.findContent(job, stored.id);
check("and reads back byte-identical", shotContent?.data?.equals(PNG) === true);
check(
  "the row holds no bytes",
  (await q(`SELECT data FROM job_screenshots WHERE id = $1`, [stored.id])).rows[0]!.data === null,
);

// A step name containing a separator must not collide with one containing a
// substituted character — the digest in the key segment is what prevents it.
const second = await screenshots.upsert({
  jobId: job,
  projectId: project,
  stepName: "Opens the cart _ reopens it",
  contentType: "image/png",
  data: Buffer.from([1, 2, 3]),
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
});
check("two steps whose names collide once sanitised keep distinct objects", second.id !== stored.id);
check(
  "and each reads back its own bytes",
  (await screenshots.findContent(job, stored.id))!.data!.equals(PNG) &&
    (await screenshots.findContent(job, second.id))!.data!.equals(Buffer.from([1, 2, 3])),
);

// --- 5. extensions ----------------------------------------------------------
console.log("\n--- extension bundles ---");
const extensions = new OrgExtensionRepository(pool, storage);
const bundle = {
  entryPath: "index.ts",
  sha256: "a".repeat(64),
  files: [
    { path: "index.ts", content: "export default function () {}\n", sizeBytes: 31 },
    { path: "src/helper.ts", content: "export const x = 1;\n", sizeBytes: 20 },
  ],
};
const created = await extensions.createOrReplace({
  organizationId: org,
  slug: "i30-extension",
  name: "I30 Extension",
  uploadedByUserId: user,
  bundle: bundle as never,
});
const delivered = await extensions.listFiles(created.id);
check(
  "a bundle's files round-trip through the bucket unchanged",
  delivered.length === 2 &&
    delivered.find((f) => f.path === "index.ts")!.content === "export default function () {}\n" &&
    delivered.find((f) => f.path === "src/helper.ts")!.content === "export const x = 1;\n",
  JSON.stringify(delivered.map((f) => f.path)),
);
check(
  "the file rows hold no content",
  (
    await q(
      `SELECT count(*)::int as n FROM org_extension_files
        WHERE extension_id = $1 AND content IS NOT NULL`,
      [created.id],
    )
  ).rows[0]!.n === 0,
);
// A replacement keeps the id, so it must also keep the keys — replacing a file
// has to overwrite the same object rather than accumulate a second one.
const replaced = await extensions.createOrReplace({
  organizationId: org,
  slug: "i30-extension",
  name: "I30 Extension v2",
  uploadedByUserId: user,
  bundle: {
    ...bundle,
    files: [{ path: "index.ts", content: "export default function () { return 2; }\n", sizeBytes: 41 }],
  } as never,
});
check("a replacement keeps the extension id", replaced.id === created.id);
check(
  "and the new content is what is delivered",
  (await extensions.listFiles(created.id)).length === 1 &&
    (await extensions.listFiles(created.id))[0]!.content.includes("return 2"),
);

// --- 6. the backfill --------------------------------------------------------
console.log("\n--- backfilling rows written before object storage existed ---");
// Put a row back into the Postgres backend, which is what a pre-existing install
// looks like, then move it.
await q(
  `UPDATE job_recordings
      SET data = $2, object_key = NULL, storage_backend = 'postgres', purged_at = NULL
    WHERE job_id = $1`,
  [job, WEBM],
);
const beforeBackfill = (
  await q(`SELECT storage_backend FROM job_recordings WHERE job_id = $1`, [job])
).rows[0]!.storage_backend;
const backfilled = await backfillObjects({ db: pool, storage });
const afterBackfill = (
  await q(
    `SELECT storage_backend, object_key, data FROM job_recordings WHERE job_id = $1`,
    [job],
  )
).rows[0]!;
check("the row started in the Postgres backend", beforeBackfill === "postgres");
check("the backfill moved it", backfilled.moved >= 1, JSON.stringify(backfilled));
check(
  "the row now points at the bucket and holds no bytes",
  afterBackfill.storage_backend === "object" &&
    afterBackfill.object_key !== null &&
    afterBackfill.data === null,
);
check(
  "the bytes survived the move unchanged",
  (await objectRecordings.findContent(job))?.data?.equals(WEBM) === true,
);

// Idempotence: a second run must find nothing to do, which is what makes the
// script safe to re-run after an interruption.
const secondRun = await backfillObjects({ db: pool, storage });
check("a second backfill is a no-op", secondRun.moved === 0, JSON.stringify(secondRun));

// --- 7. degradation --------------------------------------------------------
console.log("\n--- an install with no bucket configured ---");
const noStorage = new JobRecordingRepository(pool, null);
await noStorage.upsert({
  jobId: job,
  projectId: project,
  contentType: "video/webm",
  data: WEBM,
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
});
const degraded = (
  await q(`SELECT storage_backend, object_key FROM job_recordings WHERE job_id = $1`, [job])
).rows[0]!;
check(
  "writes fall back to Postgres rather than failing",
  degraded.storage_backend === "postgres" && degraded.object_key === null,
);
check(
  "and read back correctly",
  (await noStorage.findContent(job))?.data?.equals(WEBM) === true,
);

await pool.end();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
