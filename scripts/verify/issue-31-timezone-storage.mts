/**
 * Issue #31 part 1's storage, verified against a real PostgreSQL with every
 * migration applied.
 *
 * **Why this exists rather than only tests.** `setTimeZone` writes with
 * `jsonb_set` and the public projection reads with `->>`. Those are JSONB
 * operator semantics, which a fake pool cannot check at all — it records the SQL
 * *string* and returns canned rows without Postgres ever parsing it. That is the
 * shape of #43 (a method that raised on every call), #61 (a query ambiguous on
 * every call) and #56 (routes that 404'd): a green suite over SQL nothing ran.
 *
 * It covers both directions, because either alone can pass while the feature is
 * broken: the write lands where the read looks, **and** a stored value that is not
 * a string degrades to the default rather than reaching a client as a zone it will
 * try to render.
 *
 * **Run it like this** (from `api/`, against a scratch database on the running
 * dev stack — note `--network host`, which is what makes it reachable):
 *
 *   docker exec yggdrasil-dev-postgres-1 psql -U yggdrasil -d postgres \
 *     -c "CREATE DATABASE i31check;"
 *   docker run --rm --network host -v "$PWD":/app -w /app \
 *     -e DATABASE_URL="postgresql://yggdrasil:<password>@127.0.0.1:5432/i31check" \
 *     yggdrasil-api-test-test ./node_modules/.bin/tsx scripts/verify/issue-31-timezone-storage.mts
 *
 * `<password>` is `docker inspect yggdrasil-dev-postgres-1` →
 * `POSTGRES_PASSWORD`. It removes the rows it creates; `DROP DATABASE` is blocked
 * for agents in this sandbox, so name the database in your report.
 */
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";
import { ProjectRepository } from "../../src/projects/repository.ts";
import { toPublicProject } from "../../src/projects/types.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = (sql: string, values?: unknown[]) => pool.query(sql, values);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

await runMigrations(pool);

const stamp = Date.now();
const user = (
  await q(
    `INSERT INTO users (username, display_name, github_id, github_login)
     VALUES ($1, 'I31 verify', $2, $1) RETURNING id`,
    [`i31verify_${stamp}`, stamp],
  )
).rows[0].id;
const org = (
  await q(`INSERT INTO organizations (name, slug) VALUES ('o31v', $1) RETURNING id`, [
    `o31v_${stamp}`,
  ])
).rows[0].id;
// Required, not cosmetic: `findByIdForUser` joins `organization_memberships`, so
// a project with no membership row is invisible to every route that uses it.
await q(
  `INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'admin')`,
  [org, user],
);
const project = (
  await q(
    `INSERT INTO projects (owner_user_id, organization_id, name, slug)
     VALUES ($1, $2, 'p31v', $3) RETURNING id`,
    [user, org, `p31v_${stamp}`],
  )
).rows[0].id;

const projects = new ProjectRepository(pool);
const readBack = async () => toPublicProject((await projects.findById(project))!);

console.log("\n-- the write lands where the read looks --");
await projects.setTimeZone(project, "America/New_York");
check(
  "round-trips a zone through jsonb_set and ->>",
  (await readBack()).timeZone === "America/New_York",
);
check(
  "does not expose the internal settings bag",
  !Object.prototype.hasOwnProperty.call(await readBack(), "settings"),
);

console.log("\n-- clearing, and not clobbering siblings --");
await q(`UPDATE projects SET settings = jsonb_build_object('other','kept') WHERE id = $1`, [project]);
await projects.setTimeZone(project, null);
const cleared = (await q("SELECT settings FROM projects WHERE id = $1", [project])).rows[0].settings;
check("clearing removes the key rather than storing null", !("timezone" in cleared));
check("and leaves a sibling key alone", cleared.other === "kept");

console.log("\n-- a stored value that is not a string --");
await q(
  `UPDATE projects SET settings = jsonb_build_object('timezone', 99, 'other','kept') WHERE id = $1`,
  [project],
);
const degraded = await readBack();
check("degrades to the default rather than reaching a client", degraded.timeZone === null);
check("without hiding the rest of the row", degraded.name.length > 0);

await q(
  `UPDATE projects SET settings = jsonb_build_object('timezone','Not/AZone') WHERE id = $1`,
  [project],
);
check(
  "leaves an unresolvable zone readable, so an operator can see it",
  (await readBack()).timeZone === "Not/AZone",
);

console.log("\n-- the path every project route actually uses --");
await projects.setTimeZone(project, "Asia/Kolkata");
const forUser = await projects.findByIdForUser(project, user);
check(
  "findByIdForUser exposes it",
  forUser !== null && toPublicProject(forUser).timeZone === "Asia/Kolkata",
);

// --- clean-up ---------------------------------------------------------------
// Deletes rather than a dropped database, for the two reasons the other verify
// scripts give: `DROP DATABASE` is blocked for agents here, and the scratch
// database may be shared with a concurrent run.
await q("DELETE FROM projects WHERE id = $1", [project]);
await q("DELETE FROM organization_memberships WHERE organization_id = $1", [org]);
await q("DELETE FROM organizations WHERE id = $1", [org]);
await q("DELETE FROM users WHERE id = $1", [user]);
await pool.end();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
