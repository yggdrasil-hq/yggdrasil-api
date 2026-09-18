import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { FeatureRepository } from "./repository.js";

const FEATURE_ID = "11111111-1111-4111-8111-111111111111";

function fakePool(rows: unknown[] = []) {
  const query = vi.fn(async (_sql: string, _values: unknown[] = []) => ({ rows }));
  return { pool: { query } as unknown as pg.Pool, query };
}

/**
 * Issue #43, and the honest statement of what this file can and cannot catch.
 *
 * `updateStatus` was broken for every caller: Postgres could not deduce a single
 * type for `$2`, which was assigned to a `varchar` column and compared to an
 * untyped `'draft'` literal, so the statement raised
 * `42P08 inconsistent types deduced for parameter $2` every time. A fake pool
 * cannot reproduce that — it is a *Postgres* type-inference failure, and the fake
 * executes nothing.
 *
 * So the assertion below is a shape check: it pins the casts that make the
 * statement work, and a regression that removes them fails here rather than in
 * production. It was verified against a real database with every migration
 * applied, by calling this repository method through a real pool and checking
 * both the `failed` and `draft` branches (the latter exercises the CASE arms).
 */
describe("FeatureRepository.updateStatus", () => {
  it("casts $2 so Postgres can deduce one type for it", async () => {
    const { pool, query } = fakePool([]);
    const repository = new FeatureRepository(pool);

    await repository.updateStatus(FEATURE_ID, "failed");

    const [sql, values] = query.mock.calls[0];
    // The assignment side is varchar; the comparison side is text. Both casts
    // are required, and each was missing in the broken version.
    expect(sql).toMatch(/SET status = \$2::varchar/);
    expect(sql).toMatch(/CASE WHEN \$2::text = 'draft'/g);
    expect(sql.match(/CASE WHEN \$2::text = 'draft'/g)).toHaveLength(3);
    expect(values).toEqual([FEATURE_ID, "failed"]);
  });

  it("resets adr_approved and the return fields only when moving to draft", async () => {
    const { pool, query } = fakePool([]);
    const repository = new FeatureRepository(pool);

    await repository.updateStatus(FEATURE_ID, "draft");

    const [sql] = query.mock.calls[0];
    // `CASE WHEN … THEN FALSE ELSE adr_approved END` is what makes this
    // conditional; an unconditional reset would drop an approved ADR on an
    // unrelated transition.
    expect(sql).toMatch(/CASE WHEN \$2::text = 'draft' THEN FALSE ELSE adr_approved END/);
  });

  it("returns null when the feature does not exist", async () => {
    const { pool } = fakePool([]);
    const repository = new FeatureRepository(pool);

    expect(await repository.updateStatus(FEATURE_ID, "failed")).toBeNull();
  });
});
