import { afterAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { CAPABILITY_TRUST_MS, JobKindCapabilityRepository } from "./capabilities.js";
import { runMigrations } from "../db/migrate.js";
import { livePostgresSkipWarning, probeLivePostgres } from "../testing/live-postgres.js";

/**
 * Issue #63's capability reader.
 *
 * **This is SQL, so part of it runs against a real Postgres.** `#43` was a
 * repository method that raised on *every* call while 880 tests passed, because
 * every test used a fake pool that executed nothing; `#61` was the same shape
 * again. The freshness clause below (`reported_at >= $1`) is exactly the kind of
 * predicate a fake pool will happily confirm and Postgres may reject — comparing
 * a `timestamptz` to a wrong-typed parameter, for instance — so the expiry is
 * asserted against the real thing rather than only as a string.
 *
 * The fake-pool cases above the real ones pin the *shape* of the statement, which
 * is the cheap early signal; the real ones are the contract.
 */

interface QueryRecorder {
  pool: pg.Pool;
  query: ReturnType<typeof vi.fn>;
}

function fakePool(rows: unknown[]): QueryRecorder {
  const query = vi.fn(async () => ({ rows }));
  return { pool: { query } as unknown as pg.Pool, query };
}

describe("JobKindCapabilityRepository (statement shape)", () => {
  it("reads only the negative claims", async () => {
    const { pool, query } = fakePool([]);
    const repository = new JobKindCapabilityRepository(pool);

    await repository.unrunnable();

    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/runnable = FALSE/);
    // Positive claims are not collected: the reader's meaning is "these are
    // known-unrunnable", not "this is an inventory that must be complete".
    expect(sql).not.toMatch(/runnable = TRUE/);
  });

  it("ignores rows older than the trust window", async () => {
    const { pool, query } = fakePool([]);
    const repository = new JobKindCapabilityRepository(pool, 60_000);
    const before = Date.now() - 60_000;

    await repository.unrunnable();

    const [, values] = query.mock.calls[0];
    const cutoff = (values as Date[])[0]!;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(Date.now() - 55_000);
  });

  it("returns the kinds it was given", async () => {
    const { pool } = fakePool([{ job_kind: "script_test_run" }]);
    const repository = new JobKindCapabilityRepository(pool);

    expect([...(await repository.unrunnable())]).toEqual(["script_test_run"]);
  });

  it("defaults to a trust window measured in minutes, not seconds", () => {
    // A window shorter than a worker's reporting interval would expire the claim
    // between reports and make this flap; a much longer one would keep a stale
    // claim after the operator fixed the problem.
    expect(CAPABILITY_TRUST_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(CAPABILITY_TRUST_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

// --- the real thing --------------------------------------------------------

const connectionString = process.env.DATABASE_URL ?? "";

const reachability = await probeLivePostgres();

if (!reachability.ok) {
  console.warn(
    livePostgresSkipWarning({
      label: "capabilities",
      probe: reachability,
      unverified: "the capability read, and that an unknown job kind is ignored rather than rejected",

    }),
  );
}




let pool: pg.Pool | null = null;
if (reachability.ok) {
  pool = new pg.Pool({ connectionString });
  await runMigrations(pool);
}

afterAll(async () => {
  if (!pool) return;
  try {
    // Only the rows this file created; the table is shared with the application.
    await pool.query("delete from job_kind_capabilities where job_kind like 'test_%'");
  } finally {
    await pool.end().catch(() => undefined);
  }
});

describe.skipIf(!reachability.ok)("JobKindCapabilityRepository against a real Postgres", () => {
  it("reports a fresh negative claim and ignores a positive one", async () => {
    await pool!.query(
      `insert into job_kind_capabilities (job_kind, runnable, reported_at)
       values ('test_unrunnable', FALSE, NOW()), ('test_runnable', TRUE, NOW())
       on conflict (job_kind) do update set runnable = excluded.runnable, reported_at = excluded.reported_at`,
    );
    const repository = new JobKindCapabilityRepository(pool!);

    const unrunnable = await repository.unrunnable();

    expect(unrunnable.has("test_unrunnable" as never)).toBe(true);
    // A row saying "runnable" is not a negative claim, so it must not appear —
    // and its presence must not make the reader think the *other* kind is known
    // to be fine either.
    expect(unrunnable.has("test_runnable" as never)).toBe(false);
  });

  it("stops trusting a claim once it is older than the window", async () => {
    // The expiry is the part that protects the operator who fixed the problem:
    // without it, one report would pin the API's dispatch behaviour forever.
    await pool!.query(
      `insert into job_kind_capabilities (job_kind, runnable, reported_at)
       values ('test_stale', FALSE, NOW() - interval '2 hours')
       on conflict (job_kind) do update set runnable = excluded.runnable, reported_at = excluded.reported_at`,
    );
    const repository = new JobKindCapabilityRepository(pool!);

    expect((await repository.unrunnable()).has("test_stale" as never)).toBe(false);
    // Same row, a window wide enough to include it — proving the exclusion above
    // is the clock and not a missing row.
    const generous = new JobKindCapabilityRepository(pool!, 24 * 60 * 60 * 1000);
    expect((await generous.unrunnable()).has("test_stale" as never)).toBe(true);
  });

  it("returns an empty set on an installation that has never reported", async () => {
    // The pre-#63 behaviour, and the reason this migration is safe on its own.
    const repository = new JobKindCapabilityRepository(pool!);
    const unrunnable = await repository.unrunnable();

    expect(unrunnable.has("script_test_run" as never)).toBe(false);
  });
});
