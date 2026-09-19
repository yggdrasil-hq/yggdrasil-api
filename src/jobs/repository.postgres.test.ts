import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { JobRepository } from "./repository.js";
import { runMigrations } from "../db/migrate.js";
import { livePostgresSkipWarning, probeLivePostgres } from "../testing/live-postgres.js";

/**
 * Issue #28 part 2's read against a **real Postgres**.
 *
 * `listFeatureGrillRuns` is the one query added by this change, and it is a
 * **join** — the shape that has already taken a page down in this repo: the audit
 * list selected unqualified columns across `audit_events`/`projects`/`users`, which
 * Postgres rejected as ambiguous (`42702`) on **every** request while the unit tests
 * stayed green, because those tests assert the generated SQL *string* rather than
 * running it (issue #61).
 *
 * `jobs` and `job_events` share `id`, `status` and `created_at`, so the same class of
 * failure is one careless edit away here. A fake pool would not notice: it has no
 * opinion about whether Postgres *accepts* a statement. So these cases execute the
 * real query, against real rows, with the real `restarted_from_event_id` foreign key
 * in place.
 *
 * The second thing only a real database can show is the **join semantics**: that
 * `LEFT JOIN` on an event that exists resolves to the right job, and that the
 * `ON DELETE SET NULL` behaviour behind it (migration 037) leaves a resolvable-null
 * rather than dropping the run.
 *
 * Skipping is loud, not silent — see `testing/live-postgres.ts` for why a timeout to
 * a Docker-allocated address usually means a host VPN is shadowing the compose
 * subnet rather than anything being misconfigured.
 */

const connectionString = process.env.DATABASE_URL ?? "";

const reachability = await probeLivePostgres(connectionString);

if (!reachability.ok) {
  console.warn(
    livePostgresSkipWarning({
      label: "grill-runs",
      probe: reachability,
      unverified:
        "the feature grill-run list: that its join is unambiguous against `jobs`/" +
        "`job_events`, that ordering is by created_at, and that the supersession " +
        "lookup resolves through `restarted_from_event_id`",
    }),
  );
}

describe.skipIf(!reachability.ok)("JobRepository.listFeatureGrillRuns against a real Postgres", () => {
  let pool: pg.Pool;
  let repository: JobRepository;
  /** The feature whose runs the cases read. */
  let featureId: string;
  /** A second feature in the same project, to prove the read is scoped. */
  let otherFeatureId: string;
  const ids = { user: "", org: "", project: "" };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    await runMigrations(pool);
    repository = new JobRepository(pool);

    const stamp = Date.now();
    ids.user = (
      await pool.query(
        `INSERT INTO users (username, display_name, github_id, github_login)
         VALUES ($1, 'I28', $2, $1) RETURNING id`,
        [`i28_${stamp}`, stamp],
      )
    ).rows[0].id;
    ids.org = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ('o28', $1) RETURNING id`,
        [`o28_${stamp}`],
      )
    ).rows[0].id;
    ids.project = (
      await pool.query(
        `INSERT INTO projects (owner_user_id, organization_id, name, slug)
         VALUES ($1, $2, 'p28', $3) RETURNING id`,
        [ids.user, ids.org, `p28_${stamp}`],
      )
    ).rows[0].id;

    featureId = (
      await pool.query(
        `INSERT INTO features (project_id, title, slug, feature_type, status)
         VALUES ($1, 'grilled', $2, 'normal', 'draft') RETURNING id`,
        [ids.project, `f28_${stamp}`],
      )
    ).rows[0].id;
    otherFeatureId = (
      await pool.query(
        `INSERT INTO features (project_id, title, slug, feature_type, status)
         VALUES ($1, 'other', $2, 'normal', 'draft') RETURNING id`,
        [ids.project, `f28b_${stamp}`],
      )
    ).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    // Scoped deletes rather than a dropped database: this Postgres is shared with
    // the other real-Postgres tests in the same run. The project cascade takes the
    // features and jobs with it.
    if (pool) {
      if (ids.project) {
        await pool.query("DELETE FROM projects WHERE id = $1", [ids.project]).catch(() => undefined);
      }
      if (ids.org) {
        await pool.query("DELETE FROM organizations WHERE id = $1", [ids.org]).catch(() => undefined);
      }
      if (ids.user) {
        await pool.query("DELETE FROM users WHERE id = $1", [ids.user]).catch(() => undefined);
      }
      await pool.end();
    }
  }, 60_000);

  /** Inserts a job at an explicit time, so ordering is asserted rather than hoped. */
  async function insertJob(input: {
    feature?: string;
    kind?: string;
    status?: string;
    createdAt: string;
    restartedFromEventId?: string | null;
  }): Promise<string> {
    const row = await pool.query(
      `INSERT INTO jobs (project_id, kind, feature_id, status, created_at, restarted_from_event_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        ids.project,
        input.kind ?? "spec_grill",
        input.feature ?? featureId,
        input.status ?? "completed",
        input.createdAt,
        input.restartedFromEventId ?? null,
      ],
    );
    return row.rows[0].id;
  }

  async function insertEvent(jobId: string, createdAt = "2026-09-01T00:00:00Z"): Promise<string> {
    const row = await pool.query(
      `INSERT INTO job_events (job_id, type, created_at) VALUES ($1, 'agent_text', $2) RETURNING id`,
      [jobId, createdAt],
    );
    return row.rows[0].id;
  }

  /**
   * The assertion this whole file exists for. An unqualified column list over this
   * join raises `42702 ambiguous` — the #61 defect — and nothing but Postgres will
   * say so.
   */
  it("is accepted by Postgres, so the join is not ambiguous", async () => {
    await expect(repository.listFeatureGrillRuns(featureId)).resolves.toBeDefined();
  });

  it("returns runs for one feature only", async () => {
    // A fresh feature pair, so the case is independent of the others' rows.
    const stamp = Date.now();
    const mine = (
      await pool.query(
        `INSERT INTO features (project_id, title, slug, feature_type, status)
         VALUES ($1, 'mine', $2, 'normal', 'draft') RETURNING id`,
        [ids.project, `scope_${stamp}`],
      )
    ).rows[0].id;
    const theirs = (
      await pool.query(
        `INSERT INTO features (project_id, title, slug, feature_type, status)
         VALUES ($1, 'theirs', $2, 'normal', 'draft') RETURNING id`,
        [ids.project, `scope_other_${stamp}`],
      )
    ).rows[0].id;

    await insertJob({ feature: mine, createdAt: "2026-09-01T00:00:00Z" });
    await insertJob({ feature: theirs, createdAt: "2026-09-01T00:00:00Z" });

    const runs = await repository.listFeatureGrillRuns(mine);

    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
  });

  it("excludes jobs that are not spec_grill", async () => {
    // `feature_build` and the test kinds share the feature; only grills are a
    // "run" a rewind can supersede.
    const stamp = Date.now();
    const feat = (
      await pool.query(
        `INSERT INTO features (project_id, title, slug, feature_type, status)
         VALUES ($1, 'mixed', $2, 'normal', 'draft') RETURNING id`,
        [ids.project, `mixed_${stamp}`],
      )
    ).rows[0].id;

    await insertJob({ feature: feat, kind: "feature_build", createdAt: "2026-09-01T00:00:00Z" });
    await insertJob({ feature: feat, kind: "spec_grill", createdAt: "2026-09-02T00:00:00Z" });

    const runs = await repository.listFeatureGrillRuns(feat);

    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
  });

  /**
   * The join's whole purpose: `restarted_from_event_id` names an event in an
   * *earlier* job, and the lookup has to come back with that job's id.
   */
  it("resolves which run a rewind superseded, through the event's own job", async () => {
    const stamp = Date.now();
    const feat = (
      await pool.query(
        `INSERT INTO features (project_id, title, slug, feature_type, status)
         VALUES ($1, 'rewound', $2, 'normal', 'draft') RETURNING id`,
        [ids.project, `rewound_${stamp}`],
      )
    ).rows[0].id;

    const first = await insertJob({ feature: feat, createdAt: "2026-09-01T00:00:00Z" });
    // An event belonging to the *first* run: the turn the rewind was taken at.
    const anchor = await insertEvent(first, "2026-09-01T00:05:00Z");
    const second = await insertJob({
      feature: feat,
      createdAt: "2026-09-02T00:00:00Z",
      restartedFromEventId: anchor,
    });

    const runs = await repository.listFeatureGrillRuns(feat);

    expect(runs.map((r) => r.jobId)).toEqual([first, second]);
    // The first run was not itself a rewind.
    expect(runs[0].restartedFromEventId).toBeNull();
    expect(runs[0].supersedesJobId).toBeNull();
    // The second names its anchor *and* resolves the run it came from.
    expect(runs[1].restartedFromEventId).toBe(anchor);
    expect(runs[1].supersedesJobId).toBe(first);
  });

  it("orders by created_at ascending, which is what makes the last element current", async () => {
    // Inserted out of order on purpose: if the query relied on insertion order
    // rather than `created_at`, this is the case that would catch it.
    const stamp = Date.now();
    const feat = (
      await pool.query(
        `INSERT INTO features (project_id, title, slug, feature_type, status)
         VALUES ($1, 'ordered', $2, 'normal', 'draft') RETURNING id`,
        [ids.project, `ordered_${stamp}`],
      )
    ).rows[0].id;

    const third = await insertJob({ feature: feat, createdAt: "2026-09-03T00:00:00Z" });
    const first = await insertJob({ feature: feat, createdAt: "2026-09-01T00:00:00Z" });
    const second = await insertJob({ feature: feat, createdAt: "2026-09-02T00:00:00Z" });

    const runs = await repository.listFeatureGrillRuns(feat);

    expect(runs.map((r) => r.jobId)).toEqual([first, second, third]);
  });

  /**
   * `ON DELETE SET NULL` (migration 037) means a job outlives the event it rewound
   * from. So "the anchor is gone" is a reachable state, and the `LEFT JOIN` has to
   * yield a *resolvable null* rather than dropping the run — losing a run's history
   * because an unrelated event was deleted would be worse than losing the link.
   */
  it("keeps a run whose rewound-from event was deleted, with no link", async () => {
    const stamp = Date.now();
    const feat = (
      await pool.query(
        `INSERT INTO features (project_id, title, slug, feature_type, status)
         VALUES ($1, 'orphan', $2, 'normal', 'draft') RETURNING id`,
        [ids.project, `orphan_${stamp}`],
      )
    ).rows[0].id;

    const first = await insertJob({ feature: feat, createdAt: "2026-09-01T00:00:00Z" });
    const anchor = await insertEvent(first, "2026-09-01T00:05:00Z");
    const second = await insertJob({
      feature: feat,
      createdAt: "2026-09-02T00:00:00Z",
      restartedFromEventId: anchor,
    });

    await pool.query("DELETE FROM job_events WHERE id = $1", [anchor]);

    const runs = await repository.listFeatureGrillRuns(feat);

    expect(runs.map((r) => r.jobId)).toEqual([first, second]);
    // The FK's SET NULL fired on the row that referenced it...
    expect(runs[1].restartedFromEventId).toBeNull();
    // ...and the *earlier* run is still returned, which is the point: an
    // unresolvable link must not cost a user the transcript they came to read.
    expect(runs[0].supersedesJobId).toBeNull();
  });
});

/**
 * `recordRelayedDeltaBytes` against a **real Postgres** (ADR 033 §5).
 *
 * **Why this is a second describe in the same file.** The statement changed under
 * ADR 033: its `RETURNING` clause gained `test_id` and `kind`, because the delta path
 * now resolves its scope with the same function the stored-event path uses
 * (`liveScopeForJob`) instead of reading a bare `feature_id`. Two risks follow, and
 * both are invisible to a fake pool:
 *
 *  - **Postgres has to accept the statement.** `$2` appears twice — as an addend and
 *    as a subtrahend — which is exactly the shape of issue #43's `42P08
 *    inconsistent types deduced for parameter`; the casts are what fix it, and only a
 *    real parse proves they still do. This is the same class the file above was
 *    written for.
 *  - **The two new columns have to exist and carry the right values.** A `RETURNING`
 *    naming a column the migration never added fails here and nowhere else, and the
 *    *values* are load-bearing: `kind` is what makes a `design_grill`'s id
 *    interpretable as a session, and `test_id` is the `test:` scope's whole routing
 *    key. A null `test_id` for a scheduled run would leave the topic correct and
 *    inert — the "declared, marshalled and silently discarded" shape this burn-down
 *    has now found six times.
 *
 * The fixtures are deliberately minimal and use a job with **no feature**, because
 * that is the case the old code dropped: a design session and a scheduled test run
 * both have `feature_id IS NULL`, and both must now resolve to a scope.
 */
describe.skipIf(!reachability.ok)(
  "JobRepository.recordRelayedDeltaBytes against a real Postgres (ADR 033 §5)",
  () => {
    let pool: pg.Pool;
    let repository: JobRepository;
    const ids = { user: "", org: "", project: "", test: "" };

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString });
      await runMigrations(pool);
      repository = new JobRepository(pool);

      const stamp = Date.now();
      ids.user = (
        await pool.query(
          `INSERT INTO users (username, display_name, github_id, github_login)
           VALUES ($1, 'I33', $2, $1) RETURNING id`,
          [`i33_${stamp}`, stamp],
        )
      ).rows[0].id;
      ids.org = (
        await pool.query(
          `INSERT INTO organizations (name, slug) VALUES ('o33', $1) RETURNING id`,
          [`o33_${stamp}`],
        )
      ).rows[0].id;
      ids.project = (
        await pool.query(
          `INSERT INTO projects (owner_user_id, organization_id, name, slug)
           VALUES ($1, $2, 'p33', $3) RETURNING id`,
          [ids.user, ids.org, `p33_${stamp}`],
        )
      ).rows[0].id;
      // A real `tests` row, so `test_id` is a value the foreign key accepts rather
      // than a bare uuid the column would reject.
      ids.test = (
        await pool.query(
          // `tests` has no slug and no kind column — `name`, `spec_markdown` and
          // `schedule_cron` are the NOT NULL trio (migration 002). Written from the
          // migration rather than from memory: the first version of this fixture
          // invented `slug` and `kind`, and Postgres refused it, which is the whole
          // reason this file executes real SQL.
          `INSERT INTO tests (project_id, name, spec_markdown, schedule_cron)
           VALUES ($1, $2, '', '0 3 * * *') RETURNING id`,
          [ids.project, `t33_${stamp}`],
        )
      ).rows[0].id;
    }, 60_000);

    afterAll(async () => {
      if (pool) {
        if (ids.project) {
          await pool.query("DELETE FROM projects WHERE id = $1", [ids.project]).catch(() => undefined);
        }
        if (ids.org) {
          await pool.query("DELETE FROM organizations WHERE id = $1", [ids.org]).catch(() => undefined);
        }
        if (ids.user) {
          await pool.query("DELETE FROM users WHERE id = $1", [ids.user]).catch(() => undefined);
        }
        await pool.end();
      }
    }, 60_000);

    async function insertJob(kind: string, featureId: string | null, testId: string | null) {
      const row = await pool.query(
        `INSERT INTO jobs (project_id, kind, feature_id, test_id, status)
         VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
        [ids.project, kind, featureId, testId],
      );
      return row.rows[0].id as string;
    }

    it("is accepted by Postgres and returns the job's routing fields", async () => {
      // The statement's own acceptance, plus the three fields `liveScopeForJob`
      // needs. `featureId` null is the case that used to stop a delta dead.
      const jobId = await insertJob("design_grill", null, null);

      const recorded = await repository.recordRelayedDeltaBytes(jobId, 5);

      expect(recorded).toEqual({
        featureId: null,
        testId: null,
        jobKind: "design_grill",
        totalBytes: 5,
        previousBytes: 0,
      });
    });

    it("accumulates the byte counter and reports the value before this call", async () => {
      // `previousBytes` is what the ceiling uses to log *once* on the crossing
      // rather than on every subsequent chunk, so both numbers matter and neither is
      // derivable from the other after the fact.
      const jobId = await insertJob("spec_grill", null, null);

      const first = await repository.recordRelayedDeltaBytes(jobId, 10);
      const second = await repository.recordRelayedDeltaBytes(jobId, 4);

      expect(first).toMatchObject({ totalBytes: 10, previousBytes: 0 });
      expect(second).toMatchObject({ totalBytes: 14, previousBytes: 10 });
    });

    it("returns the test id a scheduled test_run carries, which the test topic routes on", async () => {
      // Issue #90's routing key, read back through the delta path. A null here would
      // build a correct and inert `test:null` topic — the failure mode no fake pool
      // can see.
      const jobId = await insertJob("test_run", null, ids.test);

      const recorded = await repository.recordRelayedDeltaBytes(jobId, 3);

      expect(recorded).toMatchObject({
        featureId: null,
        testId: ids.test,
        jobKind: "test_run",
      });
    });

    it("returns the feature id for a feature-scoped job, alongside its kind", async () => {
      const feature = (
        await pool.query(
          `INSERT INTO features (project_id, title, slug, feature_type, status)
           VALUES ($1, 'delta', $2, 'normal', 'draft') RETURNING id`,
          [ids.project, `f33_${Date.now()}`],
        )
      ).rows[0].id;
      const jobId = await insertJob("spec_grill", feature, null);

      const recorded = await repository.recordRelayedDeltaBytes(jobId, 1);

      expect(recorded).toMatchObject({ featureId: feature, testId: null, jobKind: "spec_grill" });
    });

    it("returns null for a job that does not exist, rather than throwing", async () => {
      // The caller distinguishes "nothing to relay" (return) from an error
      // (log), and a `42P08`-class failure would land in the wrong branch.
      await expect(
        repository.recordRelayedDeltaBytes("00000000-0000-4000-8000-000000000000", 1),
      ).resolves.toBeNull();
    });
  },
);
