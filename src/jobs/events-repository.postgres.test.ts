import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { JobEventRepository } from "./events-repository.js";
import { runMigrations } from "../db/migrate.js";
import { livePostgresSkipWarning, probeLivePostgres } from "../testing/live-postgres.js";

/**
 * Issue #38's persistence against a **real Postgres**.
 *
 * **Why this file exists.** Every other test of this repository uses a fake pool
 * that records SQL and returns canned rows — which is why a repository method
 * could throw on every call (#43) and an audit query could 500 on every request
 * (#61) behind a green suite. A fake pool has no opinion on whether Postgres
 * *accepts* a statement, and it has even less of one about whether a **new
 * column** exists: the fake returns whatever row shape the test invented, so an
 * INSERT naming a column the migration never added would pass here and fail on
 * the first real deployment.
 *
 * `question_form` is exactly that risk (`db/migrations/052_...`). These cases
 * apply the migrations and then read the column back, so the migration and the
 * repository have to agree.
 *
 * Skipping is loud, not silent — see `testing/live-postgres.ts` for why a
 * timeout to a Docker-allocated address usually means a host VPN is shadowing the
 * compose subnet rather than anything being misconfigured.
 */

const connectionString = process.env.DATABASE_URL ?? "";

const reachability = await probeLivePostgres(connectionString);

if (!reachability.ok) {
  console.warn(
    livePostgresSkipWarning({
      label: "job-events",
      probe: reachability,
      unverified:
        "the question_form column, its round trip through JSONB, and the claim that " +
        "migration 052 and JobEventRepository.create agree on its name",
    }),
  );
}

describe.skipIf(!reachability.ok)("JobEventRepository against a real Postgres", () => {
  let pool: pg.Pool;
  let repository: JobEventRepository;
  let jobId: string;
  /** Issue #25: a `design_grill` job, for the design-topic scope assertions. */
  let designJobId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    await runMigrations(pool);
    repository = new JobEventRepository(pool);

    const stamp = Date.now();
    const userId = (
      await pool.query(
        `INSERT INTO users (username, display_name, github_id, github_login)
         VALUES ($1, 'I38', $2, $1) RETURNING id`,
        [`i38_${stamp}`, stamp],
      )
    ).rows[0].id;

    // An organization is required: `projects.organization_id` is NOT NULL since
    // ADR 016, so a project cannot exist without one.
    const orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
        [`i38-org-${stamp}`],
      )
    ).rows[0].id;

    const projectId = (
      await pool.query(
        `INSERT INTO projects (owner_user_id, organization_id, name, slug)
         VALUES ($1, $2, 'I38', $3) RETURNING id`,
        [userId, orgId, `i38-${stamp}`],
      )
    ).rows[0].id;

    // A grill kind, because the route rejects `ask_user` on a kind with no chat
    // surface — and this file is about the column, not that rule, so it uses a
    // row that could legitimately carry one.
    jobId = (
      await pool.query(
        `INSERT INTO jobs (project_id, kind) VALUES ($1, 'spec_grill') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;

    // Issue #25: a `design_grill` job, which is the shape the relay's design topic
    // routes on. It has no feature and *is* a design session, so the two fields the
    // routing decision reads are both non-default here.
    designJobId = (
      await pool.query(
        `INSERT INTO jobs (project_id, kind) VALUES ($1, 'design_grill') RETURNING id`,
        [projectId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    // Scoped to this file's own rows: the scratch database is the caller's to
    // drop, but leaving a job behind would leak into any other real-Postgres file
    // that happens to count rows. ON DELETE CASCADE does the rest.
    await pool
      .query("DELETE FROM jobs WHERE id = ANY($1::uuid[])", [[jobId, designJobId]])
      .catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it("round-trips a structured question through JSONB unchanged", async () => {
    const created = await repository.create({
      jobId,
      type: "ask_user",
      question: "Which database should the API use?",
      questionForm: {
        header: "Database",
        multiSelect: false,
        options: [
          { label: "PostgreSQL", description: "Matches the existing API stack" },
          { label: "SQLite", description: null },
        ],
      },
    });

    // Read back through the *repository*, not the RETURNING row, so the SELECT's
    // column list is exercised too — a `create` that writes a column the reader
    // does not select is the same class of mismatch as one that writes a column
    // the migration does not have.
    const events = await repository.listByJob(jobId);
    const stored = events.find((event) => event.id === created.id);

    expect(stored?.questionForm).toEqual({
      header: "Database",
      multiSelect: false,
      options: [
        { label: "PostgreSQL", description: "Matches the existing API stack" },
        // JSONB preserves the null rather than dropping the key, which is what
        // lets a client read `option.description` without an existence check.
        { label: "SQLite", description: null },
      ],
    });
  });

  /*
   * Issue #73: a **jsonb array**, which is a different case from the object above
   * and the one that had no coverage at all.
   *
   * `action_items` is a jsonb array column and its only writer passes a JS array
   * (`jobs/internal-routes.ts`). `node-postgres` serialises a JS *array* as a
   * Postgres array literal rather than as JSON — so `$n::jsonb` receives `{...}`
   * instead of `[...]` and Postgres rejects it with `invalid input syntax for type
   * json`. See the repository's note on why arrays are encoded explicitly.
   *
   * This case exists because the object case passed while the array case was
   * broken: every other real-database test here writes an *object*
   * (`questionForm`), so the array path was never executed against a database. That
   * is the shape of #43/#61/#75 — SQL nothing ran.
   */
  it("round-trips a jsonb *array* through JSONB unchanged", async () => {
    const created = await repository.create({
      jobId,
      type: "submit_adr",
      markdown: "# ADR",
      actionItems: [
        { type: "secret_request", description: "Needs a provider key" },
        { type: "subtask_feature", description: "Split out the migration" },
      ],
    });

    const events = await repository.listByJob(jobId);
    const stored = events.find((event) => event.id === created.id);

    expect(stored?.actionItems).toEqual([
      { type: "secret_request", description: "Needs a provider key" },
      { type: "subtask_feature", description: "Split out the migration" },
    ]);
  });

  it("stores NULL for a prose question, and reads it back as null", async () => {
    // The other half of "the two modes coexist", and the state of every row
    // written before migration 052.
    const created = await repository.create({
      jobId,
      type: "ask_user",
      question: "What problem does this solve?",
    });

    const events = await repository.listByJob(jobId);
    const stored = events.find((event) => event.id === created.id);

    expect(stored?.questionForm).toBeNull();
  });

  it("finds a structured question with its scope, used by the live relay", async () => {
    // `findByIdWithScope` has its own column list against a join, so it is a
    // separate statement that a new column can be missing from. It is also the
    // read the live relay performs on every notification, so a missing column
    // there would surface as a delta arriving without its question.
    const created = await repository.create({
      jobId,
      type: "ask_user",
      question: "Which framework?",
      questionForm: {
        header: "Framework",
        multiSelect: true,
        options: [{ label: "Next.js", description: null }],
      },
    });

    const scoped = await repository.findByIdWithScope(created.id);

    expect(scoped?.event.questionForm).toEqual({
      header: "Framework",
      multiSelect: true,
      options: [{ label: "Next.js", description: null }],
    });
    // Issue #25: the scope also carries the job's kind, which is what lets the
    // relay route a feature-less event. Asserted here because this statement's
    // column list is spelled separately from the others', so a `j.kind` added to
    // the interface but not to the SELECT would typecheck and return `undefined`
    // at runtime — the exact class of drift this file exists to catch.
    expect(scoped?.jobKind).toBe("spec_grill");
  });

  it("returns a design session's scope with its kind, for the design topic (#25)", async () => {
    // The pair the relay decides on: no feature (so the feature topic is not an
    // option) *and* the `design_grill` kind (so the design topic is). A `null`
    // featureId alone would have been indistinguishable from a scheduled
    // `test_run`, which is why the kind had to be added to this read.
    const created = await repository.create({
      jobId: designJobId,
      type: "update_design_preview",
      snapshot: { "/index.html": "<html></html>" },
    });

    const scoped = await repository.findByIdWithScope(created.id);

    expect(scoped?.featureId).toBeNull();
    expect(scoped?.jobKind).toBe("design_grill");
    expect(scoped?.projectId).toBeTruthy();
    // And the session id the relay routes on is this job's own id — the same value
    // the REST route resolves `:sessionId` as.
    expect(scoped?.event.jobId).toBe(designJobId);
  });

  it("accepts a large structured question without truncating an option label", async () => {
    // Near the schema's per-field limits rather than over them: the point is that
    // JSONB does not silently shorten a long label, which a `VARCHAR` column
    // would have. The migration chose jsonb partly for this reason.
    const label = "x".repeat(256);
    const created = await repository.create({
      jobId,
      type: "ask_user",
      question: "Which?",
      questionForm: {
        header: "y".repeat(128),
        multiSelect: false,
        options: [
          { label, description: "z".repeat(512) },
          { label: "short", description: null },
        ],
      },
    });

    const scoped = await repository.findByIdWithScope(created.id);

    expect(scoped?.event.questionForm?.header).toHaveLength(128);
    expect(scoped?.event.questionForm?.options[0]?.label).toHaveLength(256);
    expect(scoped?.event.questionForm?.options[0]?.description).toHaveLength(512);
  });
});
