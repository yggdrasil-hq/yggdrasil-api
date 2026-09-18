/**
 * Issue #61's audit-query fix, verified against a real PostgreSQL with every
 * migration applied.
 *
 * **Why this exists rather than only tests.** `src/audit/repository.test.ts`
 * pins the *shape* of the generated clause with a fake pool, and that is exactly
 * how this bug shipped: the predicates were unqualified, `projects` also has an
 * `organization_id` column, and the fake pool had no opinion about it. The audit
 * page 500'd with `42702` on **every** request — the join-free `COUNT(*)` was
 * fine, and because the two queries share a `Promise.all`, one ambiguous
 * statement failed the whole response.
 *
 * The in-suite contract cases (`src/audit/repository.postgres.test.ts`) cover the
 * same ground, but they skip when Postgres is unreachable — and in some sandboxes
 * the container network cannot route between compose services at all, so they
 * skip there and this is what actually verifies the fix. It is committed rather
 * than left as a scratch file so the next person can re-run it. Precedent and
 * shape are `scripts/verify/issue-30-object-storage.mts`.
 *
 * **Run it like this** (from `api/`, against a scratch database on the running
 * dev stack — note `--network host`, which is what makes it reachable):
 *
 *   docker exec yggdrasil-dev-postgres-1 psql -U yggdrasil -d postgres \
 *     -c "CREATE DATABASE i61check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://yggdrasil:<password>@127.0.0.1:5432/i61check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-61-audit-query.mts
 *
 * `<password>` is `docker inspect yggdrasil-dev-postgres-1` →
 * `POSTGRES_PASSWORD`. The script creates its own organisation and clean-up
 * removes it, so the database is disposable; `DROP DATABASE` is blocked for
 * agents in this sandbox, so drop it yourself when finished.
 */
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { AuditEventRepository } from "../../src/audit/repository.ts";
import { AUDIT_EVENTS_ALIAS, buildAuditWhere } from "../../src/audit/types.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await runMigrations(pool);

// --- seed ------------------------------------------------------------------
// Unique per run, so a re-run against a database that still holds an earlier
// run's rows cannot pass on stale data. `users.username` is varchar(32), so the
// suffix is deliberately short.
const suffix = `${process.pid.toString(36)}${Date.now().toString(36).slice(-6)}`;
const org = (
  await q(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`, [
    `i61 ${suffix}`,
    `i61-${suffix}`,
  ])
).rows[0]!.id;
const otherOrg = (
  await q(`INSERT INTO organizations (name, slug) VALUES ($1,$2) RETURNING id`, [
    `i61 other ${suffix}`,
    `i61-other-${suffix}`,
  ])
).rows[0]!.id;
const githubId = Number(`${Date.now() % 10_000_000}${process.pid % 1000}`);
const actor = (
  await q(
    `INSERT INTO users (username, display_name, github_id, github_login)
     VALUES ($1,$2,$3,$1) RETURNING id`,
    [`i61-${suffix}`, "i61", githubId],
  )
).rows[0]!.id;
const project = (
  await q(
    `INSERT INTO projects (owner_user_id, organization_id, name, slug)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [actor, org, "i61 project", `i61-${suffix}`],
  )
).rows[0]!.id;

await q(
  `INSERT INTO audit_events (organization_id, project_id, actor_user_id, actor_kind, action)
   VALUES ($1,$2,$3,'user','project.created'),
          ($1,$2,$3,'user','org.invite_created'),
          ($1,NULL,NULL,'webhook','org.updated'),
          ($4,NULL,NULL,'user','org.updated')`,
  [org, project, actor, otherOrg],
);
console.log(`seeded org=${org} project=${project} otherOrg=${otherOrg}\n`);

const repository = new AuditEventRepository(pool);

// --- 1. the regression itself ---------------------------------------------
// This is issue #61: the joined page query and the join-free count query share
// one clause, and the clause used to be ambiguous in the joined one.
console.log("--- the joined page query (the one that used to 500) ---");
try {
  const page = await repository.listForOrganization(org, { limit: 50, offset: 0 });
  check(
    "listForOrganization resolves without 42702",
    page.total === 3 && page.events.length === 3,
    `total=${page.total} rows=${page.events.length}`,
  );
  check(
    "and is scoped to the requested organisation",
    page.events.every((event) => event.organizationId === org),
  );
} catch (error) {
  check("listForOrganization resolves without 42702", false, (error as Error).message);
}

// --- 2. the join still works ----------------------------------------------
// Proves the fix qualified the predicate rather than deleting the join to dodge
// the ambiguity. `project_name` can only come from the `LEFT JOIN projects`.
console.log("\n--- the join the ambiguity came from ---");
{
  const { events } = await repository.listForOrganization(org, {
    projectId: project,
    limit: 50,
    offset: 0,
  });
  check("project-scoped rows carry the joined project name", events.length === 2, `rows=${events.length}`);
  check(
    "and the name is the real one",
    events.every((event) => event.projectName === "i61 project"),
    events.map((event) => String(event.projectName)).join(","),
  );
}

// --- 3. created_at: the column a partial fix would leave broken -----------
// `organization_id` is on `audit_events` and `projects`; `created_at` is on
// those *and* `users`, so qualifying only the org filter leaves the date filters
// ambiguous. Verified as a distinct check because it is a distinct way to get
// this wrong, and it is the one a reviewer would wave through.
console.log("\n--- created_at (ambiguous across all three joined tables) ---");
{
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);

  try {
    const within = await repository.listForOrganization(org, {
      from: past,
      to: future,
      limit: 50,
      offset: 0,
    });
    check("a from/to window resolves", within.total === 3, `total=${within.total}`);

    const before = await repository.listForOrganization(org, {
      to: past,
      limit: 50,
      offset: 0,
    });
    check("and the window actually filters", before.total === 0, `total=${before.total}`);
  } catch (error) {
    check("a from/to window resolves", false, (error as Error).message);
  }
}

// --- 4. the other filters, and cross-org isolation ------------------------
console.log("\n--- action filter and cross-organisation isolation ---");
{
  const byAction = await repository.listForOrganization(org, {
    action: "project",
    limit: 50,
    offset: 0,
  });
  check(
    "an action prefix filter matches only this org's matching row",
    byAction.total === 1 && byAction.events[0]?.action === "project.created",
    `total=${byAction.total}`,
  );

  const shared = await repository.listForOrganization(org, {
    action: "org.updated",
    limit: 50,
    offset: 0,
  });
  // Both orgs have an `org.updated` row; only one belongs to this org.
  check(
    "a filter shared with another org still does not leak across",
    shared.total === 1 && shared.events[0]?.organizationId === org,
    `total=${shared.total}`,
  );

  const byActor = await repository.listForOrganization(org, {
    actorUserId: actor,
    limit: 50,
    offset: 0,
  });
  check("an actor filter resolves", byActor.total === 2, `total=${byActor.total}`);
}

// --- 5. every predicate is alias-qualified --------------------------------
// The structural guard, run against the real clause rather than a copied string.
// Enumerated so adding an unqualified predicate later fails here.
console.log("\n--- the clause itself is alias-qualified ---");
{
  const { clause } = buildAuditWhere(org, {
    projectId: project,
    actorUserId: actor,
    action: "project",
    from: new Date(),
    to: new Date(),
  });
  const predicates = clause.split(" AND ");
  check(
    `all ${predicates.length} predicates are ${AUDIT_EVENTS_ALIAS}.-qualified`,
    predicates.length === 6 && predicates.every((p) => p.startsWith(`${AUDIT_EVENTS_ALIAS}.`)),
    clause,
  );
}

// --- 6. and the raw statements, as Postgres sees them --------------------
// Belt to the repository's braces: the same two queries with the clause inlined,
// so the failure is visible as the literal 42702 rather than only as a rejected
// promise.
console.log("\n--- the two statements, directly ---");
{
  const { clause, values } = buildAuditWhere(org, {});
  const joined = `SELECT ${AUDIT_EVENTS_ALIAS}.id FROM audit_events ${AUDIT_EVENTS_ALIAS}
                    LEFT JOIN projects p ON p.id = ${AUDIT_EVENTS_ALIAS}.project_id
                    LEFT JOIN users u ON u.id = ${AUDIT_EVENTS_ALIAS}.actor_user_id
                   WHERE ${clause}`;
  const count = `SELECT COUNT(*)::text AS count FROM audit_events ${AUDIT_EVENTS_ALIAS} WHERE ${clause}`;

  for (const [label, sql] of [["joined SELECT", joined], ["COUNT(*)", count]] as const) {
    try {
      const result = await pool.query(sql, values);
      check(`${label} executes`, true, `rows=${result.rowCount}`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      check(`${label} executes`, false, `${code ?? ""} ${(error as Error).message}`);
    }
  }

  // The counter-case: unqualified, which must still be rejected. If this passes,
  // the columns are no longer ambiguous and the fix's premise needs re-reading.
  try {
    await pool.query(
      `SELECT ${AUDIT_EVENTS_ALIAS}.id FROM audit_events ${AUDIT_EVENTS_ALIAS}
         LEFT JOIN projects p ON p.id = ${AUDIT_EVENTS_ALIAS}.project_id
         LEFT JOIN users u ON u.id = ${AUDIT_EVENTS_ALIAS}.actor_user_id
        WHERE organization_id = $1`,
      values,
    );
    check("the unqualified form is still rejected", false, "it was accepted, so the schema changed");
  } catch (error) {
    check(
      "the unqualified form is still rejected",
      (error as { code?: string }).code === "42702",
      (error as { code?: string }).code ?? (error as Error).message,
    );
  }
}

// --- clean up --------------------------------------------------------------
// Additive only: exactly the rows this script created.
await q(`DELETE FROM audit_events WHERE organization_id = ANY($1::uuid[])`, [[org, otherOrg]]);
await q(`DELETE FROM projects WHERE organization_id = ANY($1::uuid[])`, [[org, otherOrg]]);
await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[org, otherOrg]]);
console.log("\ncleaned up the seeded organisation(s)");

await pool.end();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
