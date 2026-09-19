import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { JobEventRepository } from "../jobs/events-repository.js";
import { runMigrations } from "../db/migrate.js";
import { livePostgresSkipWarning, probeLivePostgres } from "../testing/live-postgres.js";
import { relayEnvelopesFor } from "./relay.js";

/**
 * Issue #100's fan-out against a **real Postgres**.
 *
 * **Why this file exists.** The pure routing half is covered in `relay.test.ts`
 * with hand-written scope objects, and that is not enough here for the reason this
 * burn-down keeps re-learning: the claim is not "given both ids, return both
 * topics". It is "**a feature-driven `test_run` row actually carries both ids, and
 * the read that the relay performs actually selects both columns**". Those are
 * different statements, and the gap between them is where #59, #73, #88 and #90 all
 * lived — a field declared, marshalled and silently discarded, which a fake pool
 * cannot see because it returns whatever row shape the test invented.
 *
 * `findByIdWithScope` reads its columns through an explicit list against a JOIN, so
 * a column added to `JobEventWithScope` but not to that SELECT typechecks and
 * returns `undefined` at runtime. The relay would then see a job with one scope and
 * quietly deliver to one surface — correct-looking, and inert.
 *
 * **The journey is the point, and it follows the row end to end**: insert a job with
 * both ids → write an event through the real repository → read it back through
 * `findByIdWithScope` → map it through `relayEnvelopesFor` → assert the topics a
 * Web client would have to build. A test that stopped at "the column is populated"
 * would not have caught a `relayEnvelopesFor` that reads only `featureId`.
 *
 * Skipping is loud rather than silent — see `testing/live-postgres.ts`.
 */

const connectionString = process.env.DATABASE_URL ?? "";

const reachability = await probeLivePostgres(connectionString);

if (!reachability.ok) {
  console.warn(
    livePostgresSkipWarning({
      label: "relay-fanout",
      probe: reachability,
      unverified:
        "that a feature-driven test_run row really carries both a feature_id and a " +
        "test_id, that findByIdWithScope selects both, and that one event therefore " +
        "reaches both the feature topic and the test topic (#100)",
    }),
  );
}

describe.skipIf(!reachability.ok)(
  "relay fan-out against a real Postgres (issue #100)",
  () => {
    let pool: pg.Pool;
    let events: JobEventRepository;
    let projectId: string;
    let featureId: string;
    let testId: string;
    /** A `test_run` with **both** ids: the shape issue #100 is about. */
    let featureDrivenRunId: string;
    /** A scheduled `test_run`: `test_id` only, the shape #90 added. */
    let scheduledRunId: string;
    /** A feature's job with no test at all: the shape that must not be widened. */
    let featureOnlyJobId: string;

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString });
      await runMigrations(pool);
      events = new JobEventRepository(pool);

      const stamp = Date.now();
      const userId = (
        await pool.query(
          `INSERT INTO users (username, display_name, github_id, github_login)
           VALUES ($1, 'I100', $2, $1) RETURNING id`,
          [`i100_${stamp}`, stamp],
        )
      ).rows[0].id;

      // An organization is required: `projects.organization_id` is NOT NULL since
      // ADR 016, so a project cannot exist without one.
      const orgId = (
        await pool.query(
          `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
          [`i100-org-${stamp}`],
        )
      ).rows[0].id;

      projectId = (
        await pool.query(
          `INSERT INTO projects (owner_user_id, organization_id, name, slug, status)
           VALUES ($1, $2, 'I100', $3, 'ready') RETURNING id`,
          [userId, orgId, `i100-${stamp}`],
        )
      ).rows[0].id;

      featureId = (
        await pool.query(
          `INSERT INTO features (project_id, title, slug, feature_type)
           VALUES ($1, 'I100 feature', $2, 'normal') RETURNING id`,
          [projectId, `i100-feature-${stamp}`],
        )
      ).rows[0].id;

      testId = (
        await pool.query(
          `INSERT INTO tests (project_id, name, spec_markdown, schedule_cron)
           VALUES ($1, 'I100 test', '', '* * * * *') RETURNING id`,
          [projectId],
        )
      ).rows[0].id;

      /*
       * The three job shapes, inserted directly rather than through a dispatch path.
       *
       * Directly is deliberate: this file is about the **read and the routing**, and
       * going through the Testing gate or the scheduler would couple it to those
       * flows' own preconditions. The one thing the insert must not fake is the pair
       * of columns, because "the row really carries both ids" is half the claim —
       * so both are written here and read back below.
       *
       * `status` is `cancelled` on all three, which is the burn-down's standing rule
       * for a fixture: `claimSQL` selects only `pending`, so nothing can pick these
       * up and run them even if a scheduler tick fires mid-suite.
       */
      featureDrivenRunId = (
        await pool.query(
          `INSERT INTO jobs (project_id, feature_id, test_id, kind, status)
           VALUES ($1, $2, $3, 'test_run', 'cancelled') RETURNING id`,
          [projectId, featureId, testId],
        )
      ).rows[0].id;

      scheduledRunId = (
        await pool.query(
          `INSERT INTO jobs (project_id, feature_id, test_id, kind, status, trigger_source)
           VALUES ($1, NULL, $2, 'test_run', 'cancelled', 'schedule') RETURNING id`,
          [projectId, testId],
        )
      ).rows[0].id;

      featureOnlyJobId = (
        await pool.query(
          `INSERT INTO jobs (project_id, feature_id, test_id, kind, status)
           VALUES ($1, $2, NULL, 'feature_build', 'cancelled') RETURNING id`,
          [projectId, featureId],
        )
      ).rows[0].id;
    });

    afterAll(async () => {
      // One statement: `features`, `tests`, `jobs` and (through `jobs`) `job_events`
      // all cascade from the project, so this removes this file's rows and nothing
      // else. No residue to hand over; the scratch database is the caller's to drop.
      await pool
        .query("DELETE FROM projects WHERE id = $1", [projectId])
        .catch(() => undefined);
      await pool.end().catch(() => undefined);
    });

    /**
     * Writes one event against `jobId` and returns the topics the relay would
     * publish it to — the whole journey, from the insert to the topic strings.
     */
    async function topicsFor(jobId: string): Promise<{
      topics: string[];
      scopes: unknown[];
      raw: { feature_id: string | null; test_id: string | null; kind: string };
    }> {
      const created = await events.create({
        jobId,
        type: "report_test_step",
        status: "passed",
        message: "2 of 5 passing",
      });

      const scoped = await events.findByIdWithScope(created.id);
      if (!scoped) throw new Error("the event just written was not readable back");

      // Read the row's own columns too, so a claim about the *routing* is tied to
      // what Postgres stored rather than to the repository's mapping alone.
      const raw = (
        await pool.query(
          `SELECT feature_id, test_id, kind FROM jobs WHERE id = $1`,
          [jobId],
        )
      ).rows[0];

      const envelopes = relayEnvelopesFor(scoped);
      return {
        topics: envelopes.map((envelope) => envelope.topic),
        scopes: envelopes.map((envelope) => (envelope.frame as { scope: unknown }).scope),
        raw,
      };
    }

    it("reaches the feature topic and the test topic for a feature-driven test_run", async () => {
      const { topics, scopes, raw } = await topicsFor(featureDrivenRunId);

      // The row really carries both ids — the fact the fan-out depends on, and the
      // one that would make a correct-looking router inert if it were null.
      expect(raw.feature_id).toBe(featureId);
      expect(raw.test_id).toBe(testId);
      expect(raw.kind).toBe("test_run");

      // The fix: two topics, feature first, from one event.
      expect(topics).toEqual([`feature:${featureId}`, `test:${testId}`]);
      // And each frame carries its **own** scope rather than one frame with two, so
      // the socket subscribed to `test:` is told what its id is and is never handed
      // the feature id its authoriser did not cover.
      expect(scopes).toEqual([
        { kind: "feature", id: featureId },
        { kind: "test", id: testId },
      ]);
    });

    it("reaches only the test topic for a scheduled test_run, which has no feature", async () => {
      const { topics, scopes, raw } = await topicsFor(scheduledRunId);

      expect(raw.feature_id).toBeNull();
      expect(raw.test_id).toBe(testId);
      // Exactly one, not "contains": a fan-out must not invent a second destination
      // for a job that has one id.
      expect(topics).toEqual([`test:${testId}`]);
      expect(scopes).toEqual([{ kind: "test", id: testId }]);
    });

    it("does not widen a feature-only job's event onto the test topic", async () => {
      const { topics, scopes, raw } = await topicsFor(featureOnlyJobId);

      expect(raw.test_id).toBeNull();
      expect(topics).toEqual([`feature:${featureId}`]);
      expect(scopes).toEqual([{ kind: "feature", id: featureId }]);
      // The negative stated explicitly, because it is the mistake the plural return
      // makes newly possible: a job with no `test_id` must not reach any test topic.
      // The project *does* have a test, so "published to every topic this project
      // has" would show up right here.
      expect(topics.some((topic) => topic.startsWith("test:"))).toBe(false);
    });

    it("carries each event's own payload on both deliveries, not a second row", async () => {
      // A fan-out is one event with two destinations. Building the frame per scope
      // is how the two copies would come to differ — one carrying a stale projection
      // of the row, or a second read returning a different event.
      const created = await events.create({
        jobId: featureDrivenRunId,
        type: "agent_text",
        message: "distinct payload marker",
      });
      const scoped = await events.findByIdWithScope(created.id);

      const envelopes = relayEnvelopesFor(scoped!);
      expect(envelopes).toHaveLength(2);
      const ids = envelopes.map(
        (envelope) => (envelope.frame as { event: { id: string } }).event.id,
      );
      const messages = envelopes.map(
        (envelope) => (envelope.frame as { event: { message: string | null } }).event.message,
      );
      expect(ids).toEqual([created.id, created.id]);
      expect(messages).toEqual(["distinct payload marker", "distinct payload marker"]);
    });
  },
);
