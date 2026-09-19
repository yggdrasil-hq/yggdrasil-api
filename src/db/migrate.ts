import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Issue #76: the advisory-lock key that makes "one migrator at a time" true.
 *
 * Two `int4`s rather than one `bigint`, because the pair is what `pg_locks`
 * exposes as `classid`/`objid` — so a diagnostic can name the holder without
 * bit-shifting the key apart. The values are the ASCII of "yggd" and "migr",
 * which makes a lock seen in `pg_locks` self-explaining and makes an accidental
 * collision with some future subsystem's key effectively impossible. This file
 * is the only place in the API that takes an advisory lock (verified), so the
 * namespace is ours to define.
 */
const MIGRATION_LOCK_CLASS = 0x79676764; // "yggd"
const MIGRATION_LOCK_OBJECT = 0x6d696772; // "migr"

/**
 * How long a replica waits for the migration lock before giving up.
 *
 * **Not "wait indefinitely", and the reason is measured rather than assumed.**
 * An earlier draft of this fix used a plain blocking `pg_advisory_lock`, on the
 * reasoning that serving with migrations unapplied is worse than waiting. That
 * reasoning is sound but it ignores how a lock is *released*, and the failure
 * mode is worse than it looks: an advisory lock is held until its **session**
 * ends, and a session whose client died abruptly does not end promptly. Measured
 * on this project's Postgres 16:
 *
 * ```
 * # session A holds the lock, then its client process is SIGKILLed
 * after +3s:   held=1
 * after +13s:  held=1
 * after +43s:  held=1
 * after +103s: held=1   -- and pg_stat_activity still shows the holder 'active'
 * ```
 *
 * The backend never noticed the dead peer, so it kept the lock for as long as its
 * query ran. On Linux the kernel's default `tcp_keepalives_idle` is 7200s, which
 * is the order of magnitude a blocking wait could stall for. A rolling restart
 * that loses one replica is bad; one where every *other* replica also hangs for
 * two hours is worse than the bug being fixed.
 *
 * So the wait is bounded. 120s is chosen to be far longer than a real pass —
 * the full set of ~50 files on an empty database is seconds — and far shorter
 * than any keepalive timeout, which means a dead holder produces a fast, loud,
 * *self-healing* failure rather than a hang: the process exits non-zero, the
 * orchestrator restarts the pod, and the retry acquires the lock because by then
 * the migrations are applied and the holder is gone.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 120_000;

/**
 * How often to retry while waiting. With a 120s budget that is at most ~480
 * trivial queries — immeasurable next to the migrations themselves — while still
 * acquiring within a quarter-second of the holder finishing.
 */
const MIGRATION_LOCK_RETRY_MS = 250;

function isPool(client: pg.PoolClient | pg.Pool): client is pg.Pool {
  return typeof (client as pg.Pool).connect === "function";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Who is holding the migration lock, for a diagnostic that can be acted on.
 *
 * "Timed out waiting for a lock" is nearly useless to an operator; "pid 34701
 * has held it for 4 minutes running `select pg_sleep(300)`" tells them what to
 * terminate. Returns null if the holder vanished between the failed attempt and
 * this query, which is itself useful information.
 */
async function describeLockHolder(
  conn: pg.PoolClient,
): Promise<string | null> {
  const { rows } = await conn.query<{
    pid: number;
    state: string | null;
    query: string | null;
    held_for: string | null;
  }>(
    `SELECT l.pid,
            a.state,
            a.query,
            (NOW() - a.query_start)::text AS held_for
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory'
        AND l.classid = $1
        AND l.objid = $2
        AND l.granted`,
    [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_OBJECT],
  );

  const holder = rows[0];
  if (!holder) return null;
  return `pid ${holder.pid} (${holder.state ?? "unknown"}), held ${holder.held_for ?? "an unknown time"}, running: ${holder.query ?? "?"}`;
}

/** The outcome of trying to take the migration lock. */
type AsyncResult = { ok: true } | { ok: false; error: string };

/**
 * Acquires the migration lock, waiting up to `MIGRATION_LOCK_TIMEOUT_MS`.
 *
 * `pg_try_advisory_lock` in a retry loop rather than a blocking
 * `pg_advisory_lock`, so the wait is bounded and observable. The uncontended case
 * — the overwhelmingly common one, since a restart usually finds every migration
 * already applied — is a single round trip with no sleep.
 */
async function acquireMigrationLock(
  conn: pg.PoolClient,
  wait: (message: string) => void,
): Promise<AsyncResult> {
  const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;
  let announced = false;

  for (;;) {
    const { rows } = await conn.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::int, $2::int) AS locked",
      [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_OBJECT],
    );
    if (rows[0]?.locked) return { ok: true };

    if (!announced) {
      announced = true;
      // Logged once, before the wait, so a slow rollout has a visible cause
      // rather than looking like a hung container.
      const holder = await describeLockHolder(conn).catch(() => null);
      wait(
        holder
          ? `another replica is migrating (${holder}); waiting up to ${MIGRATION_LOCK_TIMEOUT_MS / 1000}s`
          : `another replica is migrating; waiting up to ${MIGRATION_LOCK_TIMEOUT_MS / 1000}s`,
      );
    }

    if (Date.now() >= deadline) {
      const holder = await describeLockHolder(conn).catch(() => null);
      return {
        ok: false,
        error:
          `timed out after ${MIGRATION_LOCK_TIMEOUT_MS / 1000}s waiting for the migration lock. ` +
          (holder
            ? `It is held by ${holder} — if that session is not making progress, a previous migrator died without releasing it.`
            : "The holder could not be identified, which usually means it exited as this was being read; a restart will normally succeed.") +
          " Refusing to serve rather than run migrations concurrently.",
      };
    }

    await sleep(MIGRATION_LOCK_RETRY_MS);
  }
}

/**
 * Applies any migration in `migrations/` that `schema_migrations` does not
 * already record, with one process migrating at a time.
 *
 * **Issue #76: this used to race, and lost a replica.** The read-then-apply was a
 * check-then-act with no lock, so two replicas booting together both saw a
 * migration as unapplied and both applied it; the loser exited on
 * `23505`/`schema_migrations_pkey` before it could serve. That is the shape ADR
 * 003 §20's multi-replica commitment makes routine — a rolling restart whose new
 * pod overlaps the old one, a node drain, `up --scale api=2` on a fresh database
 * — and its symptom is deceptive, because the survivor serves normally and the
 * dead replica is visible only in its own logs.
 *
 * **The lock covers the ledger table's creation too**, not just the file loop.
 * `CREATE TABLE IF NOT EXISTS` is not atomic against itself — two sessions can
 * both find it missing and both attempt it, and the loser gets a duplicate-object
 * error — so it is the same bug in a smaller place, and it has to be inside.
 *
 * **The session is pinned to one connection for the whole pass**, which is not a
 * detail: an advisory lock belongs to a *session*, and `Pool.query` takes an
 * arbitrary connection per call. Acquiring on one connection and unlocking (or
 * migrating) on another would leave the lock held on a connection returned to the
 * pool, so the next borrower would inherit it. `runMigrations` therefore checks
 * out a dedicated client when it is handed a pool.
 *
 * Transaction scope was considered and rejected: `pg_advisory_xact_lock` would
 * release automatically, but it requires wrapping the whole pass in one
 * transaction, which changes what a mid-pass failure means (today earlier files
 * stay applied and recorded; in one transaction they would all roll back) and
 * rules out any migration that cannot run inside a transaction block. That is a
 * larger behavioural change than this fix should make, so the lock is
 * session-scoped and released explicitly.
 */
export async function runMigrations(
  client: pg.PoolClient | pg.Pool,
  options: { onWait?: (message: string) => void } = {},
): Promise<void> {
  // Narrowed with an `if` rather than a ternary: a conditional expression does
  // not narrow the binding afterwards, so `client` would still be the union on
  // the line that uses it.
  let pool: pg.Pool | null = null;
  let conn: pg.PoolClient;
  if (isPool(client)) {
    pool = client;
    conn = await client.connect();
  } else {
    conn = client;
  }

  // Distinguishes "we took the lock and must give it back" from "the pass failed
  // and the connection may be unusable", which decide how the client is released.
  let locked = false;
  let failure: unknown = null;

  try {
    const acquired = await acquireMigrationLock(conn, options.onWait ?? (() => {}));
    if (!acquired.ok) throw new Error(acquired.error);
    locked = true;

    await applyPendingMigrations(conn);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (pool) {
      // `release(err)` with a truthy argument *destroys* the connection instead
      // of returning it to the pool. Two cases need that, and both would
      // otherwise be silent:
      //
      //   - the unlock failed, so this connection still holds the migration lock
      //     and must never be handed to another borrower;
      //   - the pass threw, so the connection may be mid-statement or broken, and
      //     pg's own protocol handling cannot be trusted to have left it clean.
      //
      // A destroyed connection is replaced on the next `connect()`, so this costs
      // one connection per failed boot rather than leaking a lock forever.
      const releaseWithError = failure !== null || (locked && !(await safeUnlock(conn)));
      conn.release(releaseWithError ? new Error("migration connection discarded") : undefined);
    } else if (locked) {
      await safeUnlock(conn);
    }
  }
}

/**
 * Releases the lock, reporting whether it worked rather than throwing.
 *
 * It is called from a `finally`, where throwing would replace whatever the real
 * failure was with a secondary one. The caller acts on the boolean by discarding
 * the connection.
 */
async function safeUnlock(conn: pg.PoolClient): Promise<boolean> {
  try {
    await conn.query("SELECT pg_advisory_unlock($1::int, $2::int)", [
      MIGRATION_LOCK_CLASS,
      MIGRATION_LOCK_OBJECT,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** The ledger read and the apply loop. Assumes the caller holds the lock. */
async function applyPendingMigrations(conn: pg.PoolClient): Promise<void> {
  const migrationsDir = join(__dirname, "migrations");
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Without a ledger of what already ran, every process boot replayed every
  // migration file from 001 onward (tsx watch restarts on each save). Files
  // like 010-012 each widen job_events_type_check's allow-list with
  // DROP CONSTRAINT + ADD CONSTRAINT; Postgres revalidates all existing rows
  // against the new list on ADD CONSTRAINT. Once a later migration's wider
  // list let e.g. a 'run_started' row persist, replaying an *earlier*,
  // narrower-list migration on the next boot re-validated that same row
  // against a list that never included it, and reliably crashed the app on
  // every subsequent restart.
  const { rows } = await conn.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const applied = new Set(rows.map((row) => row.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await conn.query(sql);
    await conn.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
  }
}
