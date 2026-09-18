import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ProjectRepository } from "./repository.js";
import { runMigrations } from "../db/migrate.js";
import { toPublicProject } from "./types.js";

/**
 * Issue #31 part 1's storage, against a **real Postgres**.
 *
 * `ProjectRepository.setTimeZone` and the `PublicProject.timeZone` read are
 * `jsonb_set` / `->>` — JSONB operators whose behaviour a fake pool cannot check,
 * because a fake records the SQL string and returns canned rows without Postgres
 * ever parsing it. That is the exact shape of #43 (a method that raised on every
 * call), #61 (a query ambiguous on every call) and #56 (routes that 404'd): a
 * green suite over SQL nothing executed.
 *
 * So the cases below run the real statements, and they cover both directions —
 * the write lands where the read looks, and a *stored* value that is not a string
 * degrades to the default rather than reaching a client as a zone it will try to
 * render.
 *
 * Follows `audit/repository.postgres.test.ts` (issue #61) rather than mocking,
 * and skips loudly with the reason when Postgres is unreachable — a mock would
 * agree with the implementation by construction, which is the mistake this whole
 * file exists to avoid. The standalone pair is
 * `scripts/verify/issue-31-timezone-storage.mts`.
 */

const connectionString = process.env.DATABASE_URL ?? "";

async function probePostgres(): Promise<{ ok: boolean; detail: string }> {
  if (!connectionString) return { ok: false, detail: "DATABASE_URL is unset" };
  const probe = new pg.Pool({ connectionString, connectionTimeoutMillis: 2_000 });
  try {
    await probe.query("SELECT 1");
    return { ok: true, detail: "reachable" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await probe.end().catch(() => undefined);
  }
}

const reachability = await probePostgres();

if (!reachability.ok) {
  console.warn(
    `\n[timezone] SKIPPING the live Postgres timezone-storage cases: ${reachability.detail}.\n` +
      "  The JSONB read/write behind `PUT /:projectId/timezone` is therefore\n" +
      "  UNVERIFIED in this run. That SQL is unverifiable by a fake pool, which is\n" +
      "  why this file exists: the setting is written with `jsonb_set` and read\n" +
      "  with `->>`, and only Postgres can confirm the two agree. To verify for\n" +
      "  real, provide a reachable DATABASE_URL and run\n" +
      "  `docker compose -f docker-compose.test.yml up --build\n" +
      "   --abort-on-container-exit --exit-code-from test`,\n" +
      "  or run scripts/verify/issue-31-timezone-storage.mts.\n",
  );
}

describe.skipIf(!reachability.ok)("schedule timezone storage (issue #31 part 1)", () => {
  let pool: pg.Pool;
  let projects: ProjectRepository;
  const ids = { user: "", org: "", project: "" };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    await runMigrations(pool);
    projects = new ProjectRepository(pool);

    const stamp = Date.now();
    ids.user = (
      await pool.query(
        `INSERT INTO users (username, display_name, github_id, github_login)
         VALUES ($1, 'TZ', $2, $1) RETURNING id`,
        [`tz_${stamp}`, stamp],
      )
    ).rows[0].id;
    ids.org = (
      await pool.query(`INSERT INTO organizations (name, slug) VALUES ('otz', $1) RETURNING id`, [
        `otz_${stamp}`,
      ])
    ).rows[0].id;
    // The membership row is not optional: `findByIdForUser` — which every project
    // route goes through — joins `organization_memberships`, so a project with no
    // membership is invisible however it was created.
    await pool.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'admin')`,
      [ids.org, ids.user],
    );
    ids.project = (
      await pool.query(
        `INSERT INTO projects (owner_user_id, organization_id, name, slug)
         VALUES ($1, $2, 'ptz', $3) RETURNING id`,
        [ids.user, ids.org, `ptz_${stamp}`],
      )
    ).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      // Scoped deletes rather than a dropped database: the suite's Postgres is
      // shared with the other real-Postgres tests in this run.
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

  async function readBack() {
    const project = await projects.findById(ids.project);
    return toPublicProject(project!);
  }

  it("round-trips a zone through jsonb_set and ->>", async () => {
    await projects.setTimeZone(ids.project, "America/New_York");

    expect((await readBack()).timeZone).toBe("America/New_York");
  });

  it("clears the key rather than storing null", async () => {
    await projects.setTimeZone(ids.project, "Asia/Kolkata");
    await projects.setTimeZone(ids.project, null);

    const stored = await pool.query("SELECT settings FROM projects WHERE id = $1", [ids.project]);
    expect(Object.prototype.hasOwnProperty.call(stored.rows[0].settings, "timezone")).toBe(false);
    expect((await readBack()).timeZone).toBeNull();
  });

  it("does not clobber a sibling settings key", async () => {
    // The reason this uses `jsonb_set` rather than read-modify-write of the whole
    // object: a concurrent settings write must not lose the other's key.
    await pool.query(
      `UPDATE projects SET settings = jsonb_build_object('other', 'kept') WHERE id = $1`,
      [ids.project],
    );
    await projects.setTimeZone(ids.project, "Europe/London");

    const stored = await pool.query("SELECT settings FROM projects WHERE id = $1", [ids.project]);
    expect(stored.rows[0].settings).toMatchObject({ other: "kept", timezone: "Europe/London" });
  });

  it("degrades a stored non-string to the default, and keeps the row visible", async () => {
    // Read-tolerant: a bad stored value must not reach a client as a zone it will
    // try to render — but it must not hide the bad row from the operator either,
    // which is why the value is left as written and only the *projection* defaults.
    await pool.query(
      `UPDATE projects SET settings = jsonb_build_object('timezone', 99, 'other', 'kept') WHERE id = $1`,
      [ids.project],
    );

    const project = await readBack();
    expect(project.timeZone).toBeNull();
    expect(project).not.toHaveProperty("settings");
  });

  it("is visible through findByIdForUser, the path every project route uses", async () => {
    await projects.setTimeZone(ids.project, "Asia/Kolkata");

    const project = await projects.findByIdForUser(ids.project, ids.user);

    expect(project).not.toBeNull();
    expect(toPublicProject(project!).timeZone).toBe("Asia/Kolkata");
  });

  it("survives a stored zone this runtime cannot resolve", async () => {
    // Deliberately not re-validated on read: silently rewriting an unresolvable
    // zone to null would hide the bad row from whoever has to fix it.
    await pool.query(
      `UPDATE projects SET settings = jsonb_build_object('timezone', 'Not/AZone') WHERE id = $1`,
      [ids.project],
    );

    expect((await readBack()).timeZone).toBe("Not/AZone");
  });
});
