import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { runMigrations } from "./migrate.js";

/**
 * Issue #76: the migration pass must not race another replica.
 *
 * **What this file can and cannot prove.** The bug is two *processes* booting
 * simultaneously — an advisory lock is per-session, so two calls sharing one pool
 * never contend. A test in this process therefore cannot fail on the original
 * defect, and claiming otherwise would be the "passing test that verifies
 * nothing" failure this repo has been bitten by repeatedly (#43, #56, #61).
 *
 * The real verification is `scripts/verify/issue-76-migration-race.mts`, which
 * runs two migrator *processes* and was confirmed to fail on the pre-fix code in
 * three ways. What is worth asserting here is the **connection handling**, which
 * is where this fix can be silently wrong and which a two-process harness does
 * not inspect:
 *
 * - the lock and the migration work must happen on **one** connection, because an
 *   advisory lock belongs to a session and `Pool.query` takes an arbitrary one;
 * - the connection must be **destroyed rather than returned to the pool** when
 *   the pass fails or the unlock fails, since either case leaves it holding the
 *   lock or in an unknown state;
 * - an ordinary successful run must **release** it normally, or every boot leaks
 *   a connection.
 */

/** A pool double that records `connect`/`release` and answers the lock queries. */
function fakePool(options: { locked?: boolean; failOn?: string } = {}) {
  const queries: string[] = [];
  const releases: Array<unknown> = [];

  const client = {
    query: vi.fn(async (sql: string, _values?: unknown[]) => {
      queries.push(sql.trim().split("\n")[0]!.trim());
      if (options.failOn && sql.includes(options.failOn)) {
        throw new Error("simulated failure");
      }
      if (sql.includes("pg_try_advisory_lock")) {
        return { rows: [{ locked: options.locked ?? true }] };
      }
      if (sql.includes("pg_advisory_unlock")) {
        return { rows: [{ pg_advisory_unlock: true }] };
      }
      if (sql.includes("FROM pg_locks")) {
        return { rows: [] };
      }
      if (sql.includes("SELECT name FROM schema_migrations")) {
        // Every migration already applied, so the file loop is a no-op and this
        // test does not depend on what is in migrations/.
        const { readdirSync } = require("node:fs") as typeof import("node:fs");
        const { join } = require("node:path") as typeof import("node:path");
        const dir = join(__dirname, "migrations");
        return {
          rows: readdirSync(dir)
            .filter((f: string) => f.endsWith(".sql"))
            .map((name: string) => ({ name })),
        };
      }
      return { rows: [] };
    }),
    release: vi.fn((err?: unknown) => releases.push(err)),
  };

  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => {
      throw new Error("Pool.query must not be used: the lock needs a pinned session");
    }),
  };

  return { pool: pool as unknown as pg.Pool, client, queries, releases, connect: pool.connect };
}

describe("runMigrations — connection handling (issue #76)", () => {
  it("checks out exactly one connection and never queries the pool directly", async () => {
    const { pool, connect, queries } = fakePool();

    await runMigrations(pool);

    // The whole point: an advisory lock is per-session, so acquiring on one
    // connection and working on another would leave it held by a pooled
    // connection the next borrower inherits.
    expect(connect).toHaveBeenCalledTimes(1);
    expect((pool as unknown as { query: ReturnType<typeof vi.fn> }).query).not.toHaveBeenCalled();
    // And the lock is taken before any migration work.
    const lockAt = queries.findIndex((sql) => sql.includes("pg_try_advisory_lock"));
    const ledgerAt = queries.findIndex((sql) => sql.includes("SELECT name FROM schema_migrations"));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(ledgerAt).toBeGreaterThan(lockAt);
  });

  it("releases the connection normally on success, so an ordinary boot does not leak one", async () => {
    const { pool, releases, queries } = fakePool();

    await runMigrations(pool);

    expect(releases).toEqual([undefined]);
    expect(queries.some((sql) => sql.includes("pg_advisory_unlock"))).toBe(true);
  });

  it("destroys the connection when the pass fails, so a half-migrated session is never reused", async () => {
    const { pool, releases } = fakePool({ failOn: "CREATE TABLE IF NOT EXISTS" });

    await expect(runMigrations(pool)).rejects.toThrow("simulated failure");

    // A truthy argument to release() is what destroys it rather than pooling it.
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
  });

  it("destroys the connection when the unlock fails, so the lock cannot leak into the pool", async () => {
    const { pool, releases } = fakePool({ failOn: "pg_advisory_unlock" });

    // The pass itself succeeded, so this must not throw — but the connection
    // still holds the lock and must not be handed to anyone else.
    await runMigrations(pool);

    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
  });

  it("uses a pinned client directly when handed one, without connecting or releasing it", async () => {
    // The test helpers and verify scripts pass a pool, but `runMigrations` also
    // accepts a client — and it must not close a connection it does not own.
    const { client, queries } = fakePool();
    const asClient = client as unknown as pg.PoolClient;

    await runMigrations(asClient);

    expect(queries.some((sql) => sql.includes("pg_try_advisory_lock"))).toBe(true);
    expect(client.release).not.toHaveBeenCalled();
  });
});

describe("runMigrations — the wait is bounded and reported (issue #76)", () => {
  it("reports the wait rather than blocking silently", async () => {
    // `locked: false` makes every attempt fail, so the wait path runs. The
    // timeout is 120s of real time, which a unit test cannot spend — so this
    // asserts the *announcement*, and the two-process harness is what proves the
    // acquire/release cycle.
    const { pool, client } = fakePool({ locked: false });
    const onWait = vi.fn();

    // Force the deadline to have already passed so the loop exits immediately
    // after the first failed attempt and the announcement.
    const realNow = Date.now;
    let calls = 0;
    Date.now = () => {
      calls += 1;
      // First call sets the deadline; every later call is past it.
      return calls === 1 ? realNow() : realNow() + 10_000_000;
    };

    try {
      await expect(runMigrations(pool, { onWait })).rejects.toThrow(
        /timed out after 120s waiting for the migration lock/,
      );
    } finally {
      Date.now = realNow;
    }

    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait.mock.calls[0]![0]).toContain("another replica is migrating");
    // And it refuses rather than proceeding unlocked — a replica that cannot know
    // the schema is current must not serve.
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SELECT name FROM schema_migrations"),
      expect.anything(),
    );
  });

  it("names the holder in the timeout message when one is visible", async () => {
    const { pool, client } = fakePool({ locked: false });
    // Make the diagnostic query report a holder.
    // `as never` because the double's own return type is narrower than the
    // generic query signature; the rows below are exactly what the caller reads.
    client.query.mockImplementation((async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: false }] };
      if (sql.includes("FROM pg_locks")) {
        return {
          rows: [
            { pid: 34701, state: "active", query: "select pg_sleep(300)", held_for: "00:04:12" },
          ],
        };
      }
      return { rows: [] };
    }) as never);

    const realNow = Date.now;
    let calls = 0;
    Date.now = () => (calls++ === 0 ? realNow() : realNow() + 10_000_000);
    let message = "";
    try {
      await runMigrations(pool, { onWait: () => {} }).catch((e: Error) => {
        message = e.message;
      });
    } finally {
      Date.now = realNow;
    }

    // "Timed out waiting for a lock" is nearly useless; naming the holder is what
    // an operator can act on.
    expect(message).toContain("pid 34701");
    expect(message).toContain("select pg_sleep(300)");
  });
});
