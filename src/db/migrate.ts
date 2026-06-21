import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(client: pg.PoolClient | pg.Pool): Promise<void> {
  const sql = readFileSync(join(__dirname, "migrations", "001_auth.sql"), "utf8");
  await client.query(sql);
}
