import pg from "pg";
import { assertDatabaseUrl } from "../config.js";

/**
 * Anything that can run a query: the pool itself, or a checked-out client
 * inside an explicit transaction. Repositories that need to participate in a
 * caller's transaction (ADR 026's scheduler claims a test and creates its job
 * in one atomic step) accept this rather than a `Pool`, so the same statement
 * works either way.
 */
export type Queryable = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: assertDatabaseUrl() });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
