import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(client: pg.PoolClient | pg.Pool): Promise<void> {
  const migrationsDir = join(__dirname, "migrations");
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  await client.query(`
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
  const { rows } = await client.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const applied = new Set(rows.map((row) => row.name));

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
  }
}
