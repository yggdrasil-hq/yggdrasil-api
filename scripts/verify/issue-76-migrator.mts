/**
 * One migrator process, for `issue-76-migration-race.mts` to run two of at once.
 *
 * A separate file rather than an inline `--eval` string: `tsx --eval` compiles to
 * CJS and rejects top-level `await`, so the parent's child process would fail for
 * a reason unrelated to what is being verified. `.mts` is ESM.
 *
 * It prints `WAITED: ...` when the lock is contended, which is how the parent
 * proves the lock is real rather than inferring it from wall-clock timing.
 */
import pg from "pg";
import { runMigrations } from "../../src/db/migrate.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await runMigrations(pool, { onWait: (message) => console.log(`WAITED: ${message}`) });
console.log("MIGRATED_OK");
await pool.end();
