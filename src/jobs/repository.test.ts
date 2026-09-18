import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { JobRepository } from "./repository.js";

/**
 * Issue #24's per-job delta byte counter.
 *
 * A fake pool cannot verify SQL — that is exactly how issue #43 (a repository
 * method that always threw `42P08 inconsistent types deduced for parameter`)
 * hid behind a green suite. So this file does two separate things and is honest
 * about which is which:
 *
 *  - the shape assertions below pin *what the statement asks for* — the atomic
 *    increment, the two casts, the returned previous total — because those are
 *    what a regression would silently change;
 *  - the real behaviour, including the `42P08` risk of `$2` appearing twice, was
 *    verified against a live PostgreSQL with every migration applied. That run is
 *    not reproducible from this file, which is why the casts are commented in
 *    `repository.ts` and why the shape test is written to catch their removal.
 */

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const FEATURE_ID = "22222222-2222-4222-8222-222222222222";

function fakePool(rows: unknown[]) {
  const query = vi.fn(async (_sql: string, _values: unknown[] = []) => ({ rows }));
  return { pool: { query } as unknown as pg.Pool, query };
}

describe("JobRepository.recordRelayedDeltaBytes", () => {
  it("advances the counter atomically and reports both totals", async () => {
    // `previous_bytes` is what lets the ingest log the ceiling crossing exactly
    // once per job with no in-memory state, so it is part of the contract rather
    // than a convenience.
    const { pool, query } = fakePool([
      { feature_id: FEATURE_ID, total_bytes: "140", previous_bytes: "100" },
    ]);
    const repository = new JobRepository(pool);

    const recorded = await repository.recordRelayedDeltaBytes(JOB_ID, 40);

    expect(recorded).toEqual({
      featureId: FEATURE_ID,
      totalBytes: 140,
      previousBytes: 100,
    });

    const [sql, values] = query.mock.calls[0];
    // One statement, not read-then-write: the feature resolution and the counter
    // advance have to be the same round trip, which is what keeps the per-delta
    // query count unchanged from before this feature existed.
    expect(sql).toMatch(/UPDATE jobs/);
    expect(sql).toMatch(/delta_bytes = delta_bytes \+ \$2::bigint/);
    expect(sql).toMatch(/\(delta_bytes - \$2::bigint\) AS previous_bytes/);
    expect(sql).toMatch(/RETURNING feature_id/);
    expect(values).toEqual([JOB_ID, 40]);
  });

  it("casts both uses of $2", async () => {
    // Issue #43's shape, and the reason this assertion exists separately: `$2`
    // is an addend and a subtrahend in one statement, so without the casts
    // Postgres must deduce a single type from two contexts and raises
    // `42P08 inconsistent types deduced for parameter $2`. The statement then
    // fails on *every* call, silently, behind any fake.
    const { pool, query } = fakePool([{ feature_id: null, total_bytes: 1, previous_bytes: 0 }]);
    const repository = new JobRepository(pool);

    await repository.recordRelayedDeltaBytes(JOB_ID, 1);

    const [sql] = query.mock.calls[0];
    expect(sql.match(/\$2::bigint/g)).toHaveLength(2);
  });

  it("returns a number even though pg hands bigint back as a string", async () => {
    // pg returns bigint as a string to avoid precision loss. A string here would
    // silently change `totalBytes > ceiling` into a string comparison, which is
    // the kind of bug that only shows up at a byte count nobody reaches in a
    // test — so the conversion is explicit in the repository and asserted here.
    const { pool } = fakePool([
      { feature_id: FEATURE_ID, total_bytes: "8000001", previous_bytes: "7999999" },
    ]);
    const repository = new JobRepository(pool);

    const recorded = await repository.recordRelayedDeltaBytes(JOB_ID, 2);

    expect(typeof recorded?.totalBytes).toBe("number");
    expect(recorded?.totalBytes).toBe(8_000_001);
    expect(recorded!.totalBytes > 8_000_000).toBe(true);
  });

  it("returns null for a job that does not exist", async () => {
    // An UPDATE affecting no rows is the same outcome as "nothing to relay", so
    // the caller can treat it as a return rather than a failure.
    const { pool } = fakePool([]);
    const repository = new JobRepository(pool);

    expect(await repository.recordRelayedDeltaBytes(JOB_ID, 10)).toBeNull();
  });

  it("reports a null feature for a job that has none", async () => {
    // ADR 014's project-scoped design_grill: the counter still advances (the job
    // did produce the text) but there is no feature topic to publish to.
    const { pool } = fakePool([
      { feature_id: null, total_bytes: "10", previous_bytes: "0" },
    ]);
    const repository = new JobRepository(pool);

    const recorded = await repository.recordRelayedDeltaBytes(JOB_ID, 10);

    expect(recorded).toEqual({ featureId: null, totalBytes: 10, previousBytes: 0 });
  });
});
