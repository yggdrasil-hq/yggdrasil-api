import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { AuditEventRepository } from "./repository.js";
import { runMigrations } from "../db/migrate.js";

/**
 * Issue #61's verification: the audit repository against a **real Postgres**.
 *
 * **Why this file exists.** Every other test in this directory uses a fake pool
 * that records SQL and returns canned rows — which is why the entire audit page
 * could 500 on every request while the suite stayed green. The bug was not in
 * the TypeScript; it was in whether Postgres accepts the statement, and a fake
 * pool has no opinion about that. `listForOrganization` runs one clause against
 * two queries, and the clause was unqualified:
 *
 * ```sql
 * FROM audit_events e
 * LEFT JOIN projects p ON p.id = e.project_id   -- projects also has organization_id
 * LEFT JOIN users u ON u.id = e.actor_user_id   -- all three have created_at
 * WHERE organization_id = $1                    -- 42702: ambiguous
 * ```
 *
 * The join-free `COUNT(*)` resolved it fine, and the two run in `Promise.all`,
 * so the page query's rejection failed the whole request. Same class as #43: SQL
 * that no test executed.
 *
 * **The cases below therefore execute the real statements**, and assert on both
 * halves of correctness — that Postgres accepts them, and that the filters
 * return the rows they should. A test that only checked "does not throw" would
 * pass against a query with the predicates inverted.
 *
 * **Skipping is loud, not silent.** The suite's `docker-compose.test.yml` runs a
 * Postgres and passes `DATABASE_URL`, so the normal case runs for real. If it is
 * unreachable the cases are skipped with a warning naming what went unverified,
 * following `storage/client.test.ts` (issue #30) rather than mocking. A mock
 * here would agree with us by construction, which is the exact mistake that let
 * this bug ship. The standalone check is
 * `scripts/verify/issue-61-audit-query.mts`.
 */

const connectionString = process.env.DATABASE_URL ?? "";

/**
 * Reachability, decided by asking the database rather than by reading the
 * configuration — the same reasoning as the storage probe: "configured" is true
 * whenever the suite runs under compose, and in a sandbox whose container
 * network cannot route to Postgres a configured-but-unreachable URL would turn
 * these cases into multi-second timeouts that get ignored.
 */
async function probePostgres(): Promise<{ ok: boolean; detail: string }> {
  if (!connectionString) {
    return { ok: false, detail: "DATABASE_URL is unset" };
  }
  const probe = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  try {
    await probe.query("select 1");
    return { ok: true, detail: "" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await probe.end().catch(() => undefined);
  }
}

const reachability = await probePostgres();

if (!reachability.ok) {
  console.warn(
    `\n[audit] SKIPPING the live Postgres audit-query cases: ${reachability.detail}.\n` +
      "  The joined page query and the count query are therefore UNVERIFIED in\n" +
      "  this run, and those two are the whole of issue #61: the predicates were\n" +
      "  unqualified, `projects` also has `organization_id`, and every audit read\n" +
      "  500'd with 42702. They are not mocked on purpose — a fake pool would\n" +
      "  agree with us by construction. To verify for real, provide a reachable\n" +
      "  DATABASE_URL and run\n" +
      "  `docker compose -f docker-compose.test.yml up --build\n" +
      "   --abort-on-container-exit --exit-code-from test`,\n" +
      "  or run scripts/verify/issue-61-audit-query.mts.\n",
  );
}

/**
 * A pool for the cases below, plus the ids seeded for them.
 *
 * Migrations are applied first because nothing else in the suite does: the test
 * database starts empty, and no other test needs a schema. `runMigrations` is
 * idempotent (it records what it applied in `schema_migrations`), so this is
 * also safe on a database that already has one.
 */
const seeded = {
  organizationId: "",
  projectId: "",
  otherOrganizationId: "",
  seeded: false,
};

let pool: pg.Pool | null = null;

if (reachability.ok) {
  pool = new pg.Pool({ connectionString });
  await runMigrations(pool);

  // A unique, *short* suffix per run: short because `users.username` is
  // `varchar(32)` and the first attempt at this overflowed it, and unique so a
  // re-run against a database that still holds an earlier run's rows cannot pass
  // by accident on stale data.
  const suffix = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;

  const org = await pool.query<{ id: string }>(
    "insert into organizations (name, slug) values ($1, $2) returning id",
    [`audit-contract ${suffix}`, `audit-contract-${suffix}`],
  );
  seeded.organizationId = org.rows[0].id;

  // `github_id` is unique and a bigint, so it is derived from the clock rather
  // than from the pid — two runs sharing a pid would otherwise collide.
  const githubId = Number(`${Date.now() % 10_000_000}${process.pid % 1000}`);
  const actor = await pool.query<{ id: string }>(
    `insert into users (username, display_name, github_id, github_login)
     values ($1, $2, $3, $1) returning id`,
    [`ac-${suffix}`, "Audit Contract", githubId],
  );
  const actorId = actor.rows[0].id;

  const project = await pool.query<{ id: string }>(
    `insert into projects (owner_user_id, organization_id, name, slug)
     values ($1, $2, $3, $4) returning id`,
    [actorId, seeded.organizationId, "Audit Contract", `audit-contract-${suffix}`],
  );
  seeded.projectId = project.rows[0].id;

  // A second organisation, so the org scoping is exercised rather than assumed:
  // a query that leaked across organisations would still return rows.
  const otherOrg = await pool.query<{ id: string }>(
    "insert into organizations (name, slug) values ($1, $2) returning id",
    [`audit-contract-other ${suffix}`, `audit-contract-other-${suffix}`],
  );
  seeded.otherOrganizationId = otherOrg.rows[0].id;

  // Three rows in this org (one project-scoped, one not, one other action) and
  // one in the other org.
  await pool.query(
    `insert into audit_events (organization_id, project_id, actor_user_id, actor_kind, action)
     values ($1, $2, $3, 'user', 'project.created'),
            ($1, $2, $3, 'user', 'org.invite_created'),
            ($1, null, null, 'webhook', 'org.updated'),
            ($4, null, null, 'user', 'org.updated')`,
    [seeded.organizationId, seeded.projectId, actorId, seeded.otherOrganizationId],
  );

  seeded.seeded = true;
}

afterAll(async () => {
  if (!pool) return;
  // Leave nothing behind: the audit rows, then the projects and orgs this file
  // created. Additive cleanup only — the contract test owns exactly these rows.
  // (`DROP DATABASE` is blocked for agents in this sandbox; a table-level clean
  // is not, and is the right scope anyway since the database is shared with the
  // rest of the suite.)
  try {
    if (seeded.seeded) {
      await pool.query("delete from audit_events where organization_id = any($1::uuid[])", [
        [seeded.organizationId, seeded.otherOrganizationId],
      ]);
      await pool.query("delete from projects where organization_id = any($1::uuid[])", [
        [seeded.organizationId, seeded.otherOrganizationId],
      ]);
      await pool.query("delete from organizations where id = any($1::uuid[])", [
        [seeded.organizationId, seeded.otherOrganizationId],
      ]);
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
});

describe.skipIf(!reachability.ok)("AuditEventRepository against a real Postgres", () => {
  it("runs the joined page query and the count query without 42702 (issue #61)", async () => {
    // The regression case. Before the fix this rejected with
    // `column reference "organization_id" is ambiguous`, and because the two
    // queries share a `Promise.all`, the count query succeeding did not help.
    const repository = new AuditEventRepository(pool!);

    const result = await repository.listForOrganization(seeded.organizationId, {
      limit: 50,
      offset: 0,
    });

    // Not merely "did not throw": the join must actually resolve, and the org
    // scope must exclude the other organisation's row.
    expect(result.total).toBe(3);
    expect(result.events).toHaveLength(3);
    for (const event of result.events) {
      expect(event.organizationId).toBe(seeded.organizationId);
    }
  });

  it("joins the project name through for a project-scoped row", async () => {
    // Proves the `LEFT JOIN projects` in the failing query is intact and
    // genuinely serving data, rather than having been removed to dodge the
    // ambiguity.
    const repository = new AuditEventRepository(pool!);

    const { events } = await repository.listForOrganization(seeded.organizationId, {
      projectId: seeded.projectId,
      limit: 50,
      offset: 0,
    });

    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.projectId).toBe(seeded.projectId);
      expect(event.projectName).toBe("Audit Contract");
    }
  });

  it("filters on created_at without ambiguity — the column all three tables share", async () => {
    // The half a partial fix would miss. `organization_id` exists on
    // `audit_events` and `projects`; `created_at` exists on those *and* `users`,
    // so qualifying only the org filter leaves the date filters broken.
    const repository = new AuditEventRepository(pool!);

    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);

    const withinWindow = await repository.listForOrganization(seeded.organizationId, {
      from: past,
      to: future,
      limit: 50,
      offset: 0,
    });
    expect(withinWindow.total).toBe(3);

    const beforeWindow = await repository.listForOrganization(seeded.organizationId, {
      to: past,
      limit: 50,
      offset: 0,
    });
    expect(beforeWindow.total).toBe(0);
  });

  it("filters by actor and by action prefix through the real query", async () => {
    const repository = new AuditEventRepository(pool!);

    const byAction = await repository.listForOrganization(seeded.organizationId, {
      action: "project",
      limit: 50,
      offset: 0,
    });
    expect(byAction.events.map((event) => event.action)).toEqual(["project.created"]);

    const notThisOrg = await repository.listForOrganization(seeded.organizationId, {
      action: "org.updated",
      limit: 50,
      offset: 0,
    });
    // One matching row in this org; the identically-actioned row in the other
    // org must not appear.
    expect(notThisOrg.total).toBe(1);
    expect(notThisOrg.events[0].organizationId).toBe(seeded.organizationId);
  });

  it("paginates without the two queries disagreeing on the filter", async () => {
    const repository = new AuditEventRepository(pool!);

    const page = await repository.listForOrganization(seeded.organizationId, {
      projectId: seeded.projectId,
      limit: 1,
      offset: 1,
    });

    expect(page.total).toBe(2);
    expect(page.events).toHaveLength(1);
  });
});
