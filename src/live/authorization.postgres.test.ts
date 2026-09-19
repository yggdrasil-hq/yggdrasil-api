import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { authorizeScopeSubscription, type LiveAuthorizationDeps } from "./authorization.js";
import { FeatureRepository } from "../features/repository.js";
import { JobRepository } from "../jobs/repository.js";
import { ProjectRepository } from "../projects/repository.js";
import { TestRepository } from "../tests/repository.js";
import { runMigrations } from "../db/migrate.js";
import { livePostgresSkipWarning, probeLivePostgres } from "../testing/live-postgres.js";

/**
 * Issue #25's design-session authorisation against a **real Postgres**.
 *
 * **Why this file exists rather than only the fake-based cases.** The rule this
 * checks decides who may watch a design session's events, and it is the socket
 * equivalent of an access check — the one place where "the tests were real and
 * still missed it" is unacceptable. Every other case of this rule in
 * `authorization.test.ts` uses `vi.fn()` stand-ins for the two repositories, which
 * can prove the *order* and the *conditions* but not that the real SQL scopes
 * anything:
 *
 * - the fake's `findByIdForUser` is a closure that returns what the test told it
 *   to. The real one joins `organization_memberships` (ADR 016), and the whole
 *   isolation argument rests on that join.
 * - the fake's `findByIdForProject` returns a job for any id the test named. The
 *   real one filters `WHERE project_id = $1 AND id = $2`, which is what makes
 *   another project's session a refusal instead of a leak.
 *
 * So these cases build real rows and ask the real repositories. A fake would agree
 * with the code by construction, which is how this codebase shipped #43, #56, #61,
 * #75, #76 and #86 behind a green suite.
 *
 * The pure routing half — `relayEnvelopesFor` — is covered in `relay.test.ts` and
 * needs no database by design. What *does* need one is the claim that
 * `findByIdWithScope` actually returns the new `jobKind` column; that is asserted
 * in `jobs/events-repository.postgres.test.ts`, where the scope read lives, since
 * a fake row would return whatever shape the test invented and would pass whether
 * or not the migration and the SELECT agreed.
 */

const connectionString = process.env.DATABASE_URL ?? "";

const reachability = await probeLivePostgres(connectionString);

if (!reachability.ok) {
  console.warn(
    livePostgresSkipWarning({
      label: "design-subscription",
      probe: reachability,
      unverified:
        "who may subscribe to a design session's events: that the project lookup really joins org " +
        "memberships, that another project's session is refused, and that a resolvable non-design job " +
        "is refused on its kind rather than on a missing row",
    }),
  );
}

describe.skipIf(!reachability.ok)("authorizeScopeSubscription, design_session scope (real Postgres)", () => {
  let pool: pg.Pool;
  let projects: ProjectRepository;
  let jobs: JobRepository;
  /**
   * ADR 033 §2 keys the authorisers by kind in one registry, so the entry point's
   * dependency object names all four repositories — the two this scope uses and the
   * two it does not. Built for real rather than stubbed, because a stand-in here
   * would be a fake in the one file whose whole point is that fakes agree with the
   * code by construction.
   */
  let features: FeatureRepository;
  let tests: TestRepository;
  let authorizationDeps: LiveAuthorizationDeps;

  /** The member: owns the org and the project. */
  let memberId: string;
  /** In the same organization's tables but not a member of it. */
  let outsiderId: string;
  let projectId: string;
  let otherProjectId: string;
  let designSessionId: string;
  let featureBuildJobId: string;
  /** A design session belonging to a project the member cannot see. */
  let otherProjectSessionId: string;

  /**
   * `users.github_id` is UNIQUE, so every fixture user needs its own value. At the
   * describe scope rather than inside `beforeAll` because the cross-tenant case
   * below creates two more users of its own.
   */
  let githubId = 0;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    await runMigrations(pool);
    projects = new ProjectRepository(pool);
    jobs = new JobRepository(pool);
    features = new FeatureRepository(pool);
    tests = new TestRepository(pool);
    authorizationDeps = { projects, features, jobs, tests };

    const stamp = Date.now();
    // Offset well clear of `Date.now()`, which the other real-Postgres files use
    // directly as a github id — a shared value fails the whole run on
    // `users_github_id_key`, in whichever file happens to run second.
    githubId = stamp * 100;
    const user = async (suffix: string) =>
      (
        await pool.query(
          `INSERT INTO users (username, display_name, github_id, github_login)
           VALUES ($1, $1, $2, $1) RETURNING id`,
          [`i25_${suffix}_${stamp}`, (githubId += 1)],
        )
      ).rows[0].id as string;

    memberId = await user("member");
    outsiderId = await user("outsider");

    const orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
        [`i25-org-${stamp}`],
      )
    ).rows[0].id as string;

    /*
     * The member has to be a member *of the org*, not merely the project's owner:
     * `findByIdForUser` joins `organization_memberships`, so a project row alone
     * would not authorise anything and every case here would pass for the wrong
     * reason. Inserted explicitly rather than relying on whatever creates the
     * membership in production, so this file states the precondition it needs.
     *
     * `admin` because that is one of the five roles migration 013 allows — there is
     * no `owner` role, and `projects.owner_user_id` is a separate notion from an
     * org membership. My first attempt used `owner` and failed the whole suite on
     * `organization_memberships_role_check`, which is the constraint doing its job.
     */
    await pool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1, $2, 'admin')`,
      [orgId, memberId],
    );

    const project = async (name: string) =>
      (
        await pool.query(
          `INSERT INTO projects (owner_user_id, organization_id, name, slug)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [memberId, orgId, name, `${name.toLowerCase()}-${stamp}`],
        )
      ).rows[0].id as string;

    projectId = await project("I25A");
    otherProjectId = await project("I25B");

    const job = async (onProject: string, kind: string) =>
      (
        await pool.query(`INSERT INTO jobs (project_id, kind) VALUES ($1, $2) RETURNING id`, [
          onProject,
          kind,
        ])
      ).rows[0].id as string;

    designSessionId = await job(projectId, "design_grill");
    featureBuildJobId = await job(projectId, "feature_build");
    otherProjectSessionId = await job(otherProjectId, "design_grill");
  });

  afterAll(async () => {
    // Scoped to this file's own rows: cascading delete from the two projects takes
    // the jobs with them. The scratch database itself is the caller's to drop.
    await pool
      .query("DELETE FROM projects WHERE id = ANY($1::uuid[])", [[projectId, otherProjectId]])
      .catch(() => undefined);
    await pool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[memberId, outsiderId]]).catch(() => undefined);
    await pool.end().catch(() => undefined);
  });

  it("allows an org member to watch their project's design session", async () => {
    const decision = await authorizeScopeSubscription(
      authorizationDeps,
      {
        userId: memberId,
        projectId,
        scope: { kind: "design_session", id: designSessionId },
      },
    );

    expect(decision).toEqual({ ok: true });
  });

  it("refuses a non-member of the organization, and does not reveal the project", async () => {
    // The isolation case, against the real join: this user exists and the project
    // exists, but no membership row connects them. The refusal is `project`, the
    // same value a non-existent project produces, so the socket cannot be used to
    // probe which projects exist (ADR 019 item 3).
    const decision = await authorizeScopeSubscription(
      authorizationDeps,
      {
        userId: outsiderId,
        projectId,
        scope: { kind: "design_session", id: designSessionId },
      },
    );

    expect(decision).toEqual({ ok: false, reason: "project" });
  });

  it("refuses a real design session through the wrong project id", async () => {
    // Both ids are real and both belong to the member; they simply are not the
    // same pair. This is the case a single `jobs.findById(sessionId)` with no
    // project scope would have authorised.
    const decision = await authorizeScopeSubscription(
      authorizationDeps,
      {
        userId: memberId,
        projectId,
        scope: { kind: "design_session", id: otherProjectSessionId },
      },
    );

    expect(decision).toEqual({ ok: false, reason: "session" });
  });

  it("refuses a job in the project that is not a design session", async () => {
    // The row exists and is in the right project, so only the kind refuses it.
    // Without that condition the design-session frame would be a way to watch any
    // job's events in a project the caller can see.
    const decision = await authorizeScopeSubscription(
      authorizationDeps,
      {
        userId: memberId,
        projectId,
        scope: { kind: "design_session", id: featureBuildJobId },
      },
    );

    expect(decision).toEqual({ ok: false, reason: "session" });
  });

  it("refuses a session id that does not exist", async () => {
    const decision = await authorizeScopeSubscription(
      authorizationDeps,
      {
        userId: memberId,
        projectId,
        scope: { kind: "design_session", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      },
    );

    expect(decision).toEqual({ ok: false, reason: "session" });
  });

  it("refuses a session belonging to another organization's project entirely", async () => {
    // A third organization, a third project, a real design session — and a user
    // who is a member of nothing. Modelled because it is the shape a cross-tenant
    // subscription attempt actually takes: a valid session id, quoted at a project
    // the caller has no relationship with.
    const stamp = Date.now();
    const strangerProject = (
      await pool.query(
        `INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`,
        [`i25-other-org-${stamp}`],
      )
    ).rows[0].id as string;
    const strangerOwner = (
      await pool.query(
        `INSERT INTO users (username, display_name, github_id, github_login)
         VALUES ($1, $1, $2, $1) RETURNING id`,
        [`i25_stranger_${stamp}`, (githubId += 1)],
      )
    ).rows[0].id as string;
    const strangerProjectId = (
      await pool.query(
        `INSERT INTO projects (owner_user_id, organization_id, name, slug)
         VALUES ($1, $2, 'I25C', $3) RETURNING id`,
        [strangerOwner, strangerProject, `i25c-${stamp}`],
      )
    ).rows[0].id as string;
    const strangerSessionId = (
      await pool.query(
        `INSERT INTO jobs (project_id, kind) VALUES ($1, 'design_grill') RETURNING id`,
        [strangerProjectId],
      )
    ).rows[0].id as string;

    try {
      // Quoting the stranger's own project: a member of nothing, so refused on the
      // project before the session is ever read.
      expect(
        await authorizeScopeSubscription(
          authorizationDeps,
          {
          userId: memberId,
          projectId: strangerProjectId,
          scope: { kind: "design_session", id: strangerSessionId },
        },
        ),
      ).toEqual({ ok: false, reason: "project" });

      // Quoting *their own* project with the stranger's session id: authorised for
      // the project, refused on the session — which is the pair of conditions
      // together doing the work rather than either alone.
      expect(
        await authorizeScopeSubscription(
          authorizationDeps,
          {
          userId: memberId,
          projectId,
          scope: { kind: "design_session", id: strangerSessionId },
        },
        ),
      ).toEqual({ ok: false, reason: "session" });
    } finally {
      await pool
        .query("DELETE FROM projects WHERE id = $1", [strangerProjectId])
        .catch(() => undefined);
      await pool.query("DELETE FROM users WHERE id = $1", [strangerOwner]).catch(() => undefined);
    }
  });
});
