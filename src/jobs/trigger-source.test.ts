import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOB_TRIGGER_SOURCES } from "./types.js";

/**
 * Issue #75: the guard TypeScript cannot provide.
 *
 * `jobs.trigger_source`'s allowed values live in a SQL `CHECK` constraint, and
 * the TypeScript union lives in `types.ts`. **Nothing connects them.** A row type
 * narrower than the column compiles happily, because a `pg` row is typed by
 * assertion rather than by the database — so `"manual"` was added to the column
 * in migration 049 and to only some of the five declarations that described it,
 * and a manual run came back as a value its own response type said could not
 * occur.
 *
 * This is the third instance of that class in this repo: #68 was a comment
 * asserting a wrong fact about Express, #61 was a unit test asserting the broken
 * SQL string, and this is a declaration disagreeing with its own schema. All
 * three share a shape — **a statement about reality that nothing checks against
 * reality** — which is why the fix here is a test rather than only a wider union.
 *
 * Reading the migration files, rather than querying `pg_constraint`, is
 * deliberate: it needs no database, so it runs on every machine and cannot be
 * skipped, and it is the *migrations* that are the source of truth for what the
 * schema should be. (A live-database assertion would be a good second guard; it
 * would also be the one that gets skipped in a sandbox, which is the failure this
 * test exists to avoid.) The pair for the live check is
 * `scripts/verify/issue-75-manual-trigger.mts`.
 */

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../db/migrations");

/**
 * The allowed values from the **last** migration that constrains
 * `jobs.trigger_source`.
 *
 * Last, not "any": each constraint change in this repo drops and re-adds the
 * CHECK (`019`, then `049`), so only the newest one describes the live schema and
 * an earlier file's list is history. Reading them in filename order is how the
 * migration runner applies them, so the ordering here matches the database's own.
 */
function allowedTriggerSources(): { values: string[]; file: string } | null {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();

  let latest: { values: string[]; file: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    if (!sql.includes("jobs_trigger_source_check")) continue;

    // Matches `IN ('feature', 'schedule', 'manual')` on the ADD CONSTRAINT.
    const match = /jobs_trigger_source_check[\s\S]*?IN\s*\(([^)]*)\)/i.exec(sql);
    if (!match) continue;

    const values = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    if (values.length > 0) latest = { values: values.sort(), file };
  }
  return latest;
}

describe("job trigger sources agree with the schema (issue #75)", () => {
  it("finds the constraint, so this test cannot silently pass by matching nothing", () => {
    // Without this, a rename of the constraint would make the test below compare
    // an empty list against an empty list and go green — the exact "assertion
    // about reality that checks nothing" this file exists to prevent.
    const found = allowedTriggerSources();

    expect(found, "no migration constrains jobs_trigger_source").not.toBeNull();
    expect(found!.values.length).toBeGreaterThan(0);
    expect(found!.file).toBe("049_manual_test_runs.sql");
  });

  it("declares exactly the values the CHECK allows", () => {
    const found = allowedTriggerSources();
    if (!found) throw new Error("no trigger-source constraint found");

    expect([...JOB_TRIGGER_SOURCES].sort()).toEqual(found.values);
  });

  it("includes manual, which is the value that was missing", () => {
    // Named separately so a regression reports the specific drift rather than
    // just "arrays differ".
    expect([...JOB_TRIGGER_SOURCES]).toContain("manual");
  });

  it("has no duplicates, which a union would silently collapse anyway", () => {
    expect(new Set(JOB_TRIGGER_SOURCES).size).toBe(JOB_TRIGGER_SOURCES.length);
  });
});
