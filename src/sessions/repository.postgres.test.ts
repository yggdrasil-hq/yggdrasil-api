import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations } from "../db/migrate.js";
import { livePostgresSkipWarning, probeLivePostgres } from "../testing/live-postgres.js";
import { JobSessionRepository } from "./repository.js";

/**
 * ADR 032 item 1's storage, verified against a **real Postgres** rather than
 * reasoned about.
 *
 * **Why this file exists rather than only a fake-pool test.** Every claim here is
 * about what the *database* does, and a fake pool agrees with the code by
 * construction:
 *
 * - the four byte states are enforced by a `CHECK` constraint written in SQL, and
 *   a mock has no opinion on whether Postgres accepts the rows this repository
 *   builds — which is how #43 (a method that threw on every call) and #61 (a query
 *   that 500'd on every request) shipped behind a green suite;
 * - `purgeExpired`'s predicate is SQL (`expires_at <= NOW()`, plus item 4's
 *   `reclaimAll` short-circuit), and the *rule* it mirrors lives in TypeScript;
 * - the whole point of item 5 is that two outcomes with no bytes are stored
 *   distinguishably, and only a real `SELECT` back proves they survived the round
 *   trip.
 *
 * The migration runs here too, so this file is also the check that migration 054
 * applies on a real server and accepts every row shape the code produces.
 *
 * Skipping is loud rather than silent — see `testing/live-postgres.ts`, and note
 * that `scripts/test-against-real-db.sh` is what converts this from a skip into a
 * check.
 */

const connectionString = process.env.DATABASE_URL ?? "";

const reachability = await probeLivePostgres(connectionString);

if (!reachability.ok) {
  console.warn(
    livePostgresSkipWarning({
      label: "session-storage",
      probe: reachability,
      unverified:
        "that a stored session round-trips through Postgres, that the four byte " +
        "states are enforced, that an expired session is reclaimed while a failing " +
        "outcome is left alone, and that item 4's zero cap reclaims everything",
    }),
  );
}

describe.skipIf(!reachability.ok)("JobSessionRepository against a real Postgres", () => {
  let pool: pg.Pool;
  let projectId: string;
  let jobId: string;
  let sessions: JobSessionRepository;

  const bytes = Buffer.from('{"type":"user","id":"e1","text":"hi"}\n');

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    await runMigrations(pool);
    sessions = new JobSessionRepository(pool);

    const stamp = Date.now();
    const userId = (
      await pool.query(
        `INSERT INTO users (username, display_name, github_id, github_login)
         VALUES ($1, 'I28', $2, $1) RETURNING id`,
        [`i28_${stamp}`, stamp],
      )
    ).rows[0].id;
    const orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
        [`i28-org-${stamp}`],
      )
    ).rows[0].id;
    projectId = (
      await pool.query(
        `INSERT INTO projects (owner_user_id, organization_id, name, slug, status)
         VALUES ($1, $2, 'I28', $3, 'ready') RETURNING id`,
        [userId, orgId, `i28-${stamp}`],
      )
    ).rows[0].id;
    jobId = (
      await pool.query(
        `INSERT INTO jobs (project_id, kind, status)
         VALUES ($1, 'spec_grill', 'completed') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    // One statement: `job_sessions` and `jobs` both cascade from the project, so
    // this removes this file's rows and nothing else. The scratch database is the
    // caller's to drop.
    await pool
      .query("DELETE FROM projects WHERE id = $1", [projectId])
      .catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  const expiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  it("round-trips a collected session, and stores the size it measured itself", async () => {
    const stored = await sessions.upsert({
      jobId,
      projectId,
      outcome: "collected",
      sessionId: "s-1",
      podFilePath: "/root/.pi/agent/sessions/x.jsonl",
      data: bytes,
      expiresAt: expiry,
    });

    expect(stored.outcome).toBe("collected");
    // Measured from the buffer rather than accepted as an argument: the wire
    // contract deliberately has no size field, so this number is authoritative.
    expect(stored.byteSize).toBe(bytes.byteLength);
    expect(stored.sessionId).toBe("s-1");

    // Read back through a fresh query rather than trusting the RETURNING row, so
    // the claim is about what Postgres holds.
    const reread = await sessions.findByJob(jobId);
    expect(reread?.byteSize).toBe(bytes.byteLength);
    expect(reread?.podFilePath).toBe("/root/.pi/agent/sessions/x.jsonl");

    const content = await sessions.findContent(jobId);
    expect(content?.data?.toString()).toBe(bytes.toString());
  });

  /**
   * Item 5's load-bearing case. Both have no bytes; they must not be the same row.
   */
  it("stores not_collected and unavailable as distinguishable rows, both without bytes", async () => {
    const other = await pool.query(
      `INSERT INTO jobs (project_id, kind, status)
       VALUES ($1, 'spec_grill', 'completed') RETURNING id`,
      [projectId],
    );
    const otherId = other.rows[0].id as string;

    await sessions.upsert({
      jobId: otherId,
      projectId,
      outcome: "not_collected",
      sessionId: null,
      podFilePath: null,
      data: null,
      expiresAt: null,
    });

    const row = await sessions.findByJob(otherId);
    expect(row?.outcome).toBe("not_collected");
    expect(row?.byteSize).toBeNull();
    expect(row?.expiresAt).toBeNull();
    expect(row?.purgedAt).toBeNull();
    expect((await sessions.findContent(otherId))?.data).toBeNull();

    // And the third, on the same job: a later post replaces the outcome, which is
    // what the Orchestrator's downgrade-on-failed-post depends on.
    await sessions.upsert({
      jobId: otherId,
      projectId,
      outcome: "unavailable",
      sessionId: null,
      podFilePath: null,
      data: null,
      expiresAt: null,
    });
    expect((await sessions.findByJob(otherId))?.outcome).toBe("unavailable");
  });

  /**
   * The constraint is written in SQL and is the only thing that can say "a row
   * claiming to be collected while holding no bytes anywhere is unwritable", so
   * exercising it is the point rather than an extra.
   */
  it("refuses, at the database, a collected row with no bytes anywhere", async () => {
    await expect(
      pool.query(
        `INSERT INTO job_sessions
           (job_id, project_id, outcome, byte_size, data, object_key, storage_backend,
            expires_at, purged_at)
         VALUES ($1, $2, 'collected', 10, NULL, NULL, 'postgres', NOW(), NULL)`,
        [jobId, projectId],
      ),
    ).rejects.toThrow(/job_sessions_state_consistent/);
  });

  it("refuses, at the database, a failing outcome that carries a size", async () => {
    await expect(
      pool.query(
        `INSERT INTO job_sessions
           (job_id, project_id, outcome, byte_size, data, object_key, storage_backend,
            expires_at, purged_at)
         VALUES ($1, $2, 'unavailable', 10, NULL, NULL, 'postgres', NULL, NULL)`,
        [jobId, projectId],
      ),
    ).rejects.toThrow(/job_sessions_state_consistent/);
  });

  it("refuses, at the database, a failing outcome stamped as reclaimed", async () => {
    // Stamping `purged_at` on a row that never held bytes would render as "this
    // was reclaimed" for an artifact that was never stored.
    await expect(
      pool.query(
        `INSERT INTO job_sessions
           (job_id, project_id, outcome, byte_size, data, object_key, storage_backend,
            expires_at, purged_at)
         VALUES ($1, $2, 'not_collected', NULL, NULL, NULL, 'postgres', NULL, NOW())`,
        [jobId, projectId],
      ),
    ).rejects.toThrow(/job_sessions_state_consistent/);
  });

  it("reclaims an expired session into a tombstone that keeps its size", async () => {
    const expiredJob = (
      await pool.query(
        `INSERT INTO jobs (project_id, kind, status)
         VALUES ($1, 'spec_grill', 'completed') RETURNING id`,
        [projectId],
      )
    ).rows[0].id as string;

    await sessions.upsert({
      jobId: expiredJob,
      projectId,
      outcome: "collected",
      sessionId: "s-2",
      podFilePath: null,
      data: bytes,
      expiresAt: new Date(Date.now() - 60_000),
    });

    expect(await sessions.purgeExpired()).toBeGreaterThanOrEqual(1);

    const row = await sessions.findByJob(expiredJob);
    expect(row?.purgedAt).not.toBeNull();
    // The size survives the bytes, so "how large was it" stays explicable — the
    // same property migration 041 gave recordings.
    expect(row?.byteSize).toBe(bytes.byteLength);
    expect((await sessions.findContent(expiredJob))?.data).toBeNull();

    // Idempotent: the row no longer holds bytes, so a second pass finds nothing to
    // do for it.
    const candidate = await pool.query(
      `SELECT job_id FROM job_sessions
        WHERE job_id = $1 AND (data IS NOT NULL OR object_key IS NOT NULL)`,
      [expiredJob],
    );
    expect(candidate.rows).toHaveLength(0);
  });

  it("leaves an unexpired session alone", async () => {
    const freshJob = (
      await pool.query(
        `INSERT INTO jobs (project_id, kind, status)
         VALUES ($1, 'spec_grill', 'completed') RETURNING id`,
        [projectId],
      )
    ).rows[0].id as string;

    await sessions.upsert({
      jobId: freshJob,
      projectId,
      outcome: "collected",
      sessionId: null,
      podFilePath: null,
      data: bytes,
      expiresAt: expiry,
    });
    await sessions.purgeExpired();

    const row = await sessions.findByJob(freshJob);
    expect(row?.purgedAt).toBeNull();
    expect((await sessions.findContent(freshJob))?.data?.toString()).toBe(
      bytes.toString(),
    );
  });

  /**
   * ADR 032 item 4: "if it is set to zero it must mean 'reclaim everything', not
   * 'keep forever'". Verified explicitly, because `0` reads like "no limit" and the
   * two readings are opposite.
   */
  it("reclaims a session that is not yet expired when collection is switched off", async () => {
    const freshJob = (
      await pool.query(
        `INSERT INTO jobs (project_id, kind, status)
         VALUES ($1, 'spec_grill', 'completed') RETURNING id`,
        [projectId],
      )
    ).rows[0].id as string;

    await sessions.upsert({
      jobId: freshJob,
      projectId,
      outcome: "collected",
      sessionId: null,
      podFilePath: null,
      data: bytes,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    });

    // Not reclaimed by an ordinary pass...
    await sessions.purgeExpired();
    expect((await sessions.findByJob(freshJob))?.purgedAt).toBeNull();

    // ...and reclaimed by a `reclaimAll` pass, despite a year of window left.
    expect(await sessions.purgeExpired(50, true)).toBeGreaterThanOrEqual(1);
    expect((await sessions.findByJob(freshJob))?.purgedAt).not.toBeNull();
  });

  it("does not touch a failing outcome's row when reclaiming everything", async () => {
    // A failing outcome never held bytes, so there is nothing to reclaim and the
    // row must keep its NULL `purged_at` — otherwise "this run produced no session"
    // would render as "this was reclaimed".
    const row = await pool.query(
      `SELECT job_id FROM job_sessions
        WHERE project_id = $1 AND outcome <> 'collected' AND purged_at IS NOT NULL`,
      [projectId],
    );
    expect(row.rows).toHaveLength(0);
  });
});

/**
 * ADR 032 items 2/3: the fork points, against a real Postgres.
 *
 * **Why this belongs in this file rather than a fake-pool test.** Everything
 * interesting here is about what the *database* does: a new table with its own
 * `CHECK`, a JSONB round trip that must preserve Pi's answer order, and a retention
 * deletion that has to fire in the same pass as the bytes. A fake pool agrees with
 * the code by construction, and this suite has already shipped two bugs of exactly
 * that shape (#43, #61) behind green tests. The `jsonb` cast in particular is the
 * kind of thing a mock cannot have an opinion about.
 */
describe.skipIf(!reachability.ok)("fork points against a real Postgres (#103)", () => {
  let pool: pg.Pool;
  let projectId: string;
  let sessions: JobSessionRepository;

  const points = [
    { entryId: "a1b2c3d4", text: "First: make me a portfolio site." },
    { entryId: "c3d4e5f6", text: "Second: add a projects section." },
  ];

  // Byte content for the retention test below. The values do not matter — only that
  // the row holds *something* — but it has to be JSONL-shaped, because that is what
  // this column holds in production.
  const bytes = Buffer.from('{"type":"user","id":"a1b2c3d4","text":"hi"}\n');

  /** A fresh job per test, so one test's rows cannot decide another's. */
  async function freshJob(): Promise<string> {
    const id = (
      await pool.query(
        `INSERT INTO jobs (project_id, kind, status)
         VALUES ($1, 'spec_grill', 'completed') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
    return id;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    await runMigrations(pool);
    sessions = new JobSessionRepository(pool);

    const stamp = Date.now();
    const userId = (
      await pool.query(
        `INSERT INTO users (username, display_name, github_id, github_login)
         VALUES ($1, 'I103', $2, $1) RETURNING id`,
        [`i103_${stamp}`, stamp],
      )
    ).rows[0].id;
    const orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
        [`i103-org-${stamp}`],
      )
    ).rows[0].id;
    projectId = (
      await pool.query(
        `INSERT INTO projects (owner_user_id, organization_id, name, slug, status)
         VALUES ($1, $2, 'I103', $3, 'ready') RETURNING id`,
        [userId, orgId, `i103-${stamp}`],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    // Cascades to `jobs` and `job_fork_points` from the project, so this removes
    // this file's rows and nothing else. The scratch database is the caller's to
    // drop.
    await pool
      .query("DELETE FROM projects WHERE id = $1", [projectId])
      .catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it("round-trips captured points, preserving Pi's own order and text", async () => {
    const job = await freshJob();
    await sessions.upsertForkPoints(job, "captured", points);

    const read = await sessions.findForkPoints(job);
    expect(read?.state).toBe("captured");
    expect(read?.outcome).toBe("captured");
    // Read back rather than trusting what was written, so the claim is about what
    // Postgres holds — and the *order* matters, because the list is rendered in it.
    expect(read?.points).toEqual(points);
  });

  it("reads an answered-empty list as captured with nothing, not as a failure", async () => {
    const job = await freshJob();
    await sessions.upsertForkPoints(job, "captured", []);

    const read = await sessions.findForkPoints(job);
    // The distinction the whole feature turns on: Pi answered and there are none.
    expect(read?.state).toBe("captured");
    expect(read?.points).toEqual([]);
    expect(read?.points).not.toBeNull();
  });

  it("stores unavailable with no points at all, and reads it as unavailable", async () => {
    const job = await freshJob();
    await sessions.upsertForkPoints(job, "unavailable", null);

    const read = await sessions.findForkPoints(job);
    expect(read?.state).toBe("unavailable");
    expect(read?.points).toBeNull();
  });

  it("reports no record as null, which the caller maps to unknown", async () => {
    // Null rather than `captured: []`: this API was never told anything, which is a
    // different claim from "Pi said there are none".
    const job = await freshJob();
    expect(await sessions.findForkPoints(job)).toBeNull();
  });

  it("replaces on a re-delivery rather than failing on the primary key", async () => {
    const job = await freshJob();
    await sessions.upsertForkPoints(job, "unavailable", null);
    // The second delivery supersedes the first, because a retried capture that
    // succeeded must not be blocked by an earlier failure's row.
    await sessions.upsertForkPoints(job, "captured", points);

    const read = await sessions.findForkPoints(job);
    expect(read?.state).toBe("captured");
    expect(read?.points).toEqual(points);
  });

  it("refuses, in the database, an unanswered outcome that carries points", async () => {
    // The CHECK is the guard, not this repository's validation: a direct INSERT
    // that contradicts itself must be unwritable, exactly as the session table's
    // four byte states are. Asserting on the constraint rather than on the code means
    // a future path that bypassed the repository would still be stopped.
    const job = await freshJob();
    await expect(
      pool.query(
        `INSERT INTO job_fork_points (job_id, outcome, points)
         VALUES ($1, 'unavailable', $2::jsonb)`,
        [job, JSON.stringify(points)],
      ),
    ).rejects.toThrow(/job_fork_points_outcome_consistent/);

    // ...and its mirror: a captured row with no list, which would read as "there are
    // none" for a question whose answer was never recorded.
    await expect(
      pool.query(
        `INSERT INTO job_fork_points (job_id, outcome, points)
         VALUES ($1, 'captured', NULL)`,
        [job],
      ),
    ).rejects.toThrow(/job_fork_points_outcome_consistent/);
  });

  it("reclaims the fork points in the same pass that reclaims the bytes", async () => {
    // ADR 032's data-retention reasoning: a fork point's `text` is a copy of the
    // conversation the window was applied to, so leaving it behind would keep
    // conversation text past the window that reclaimed the session it came from.
    const job = await freshJob();
    await sessions.upsert({
      jobId: job,
      projectId,
      outcome: "collected",
      sessionId: "s-1",
      podFilePath: "/root/.pi/agent/sessions/x.jsonl",
      data: bytes,
      expiresAt: new Date(Date.now() - 60_000), // already past its window
    });
    await sessions.upsertForkPoints(job, "captured", points);
    expect(await sessions.findForkPoints(job)).not.toBeNull();

    await sessions.purgeExpired();

    expect((await sessions.findByJob(job))?.purgedAt).not.toBeNull();
    expect(await sessions.findForkPoints(job)).toBeNull();
  });
});
