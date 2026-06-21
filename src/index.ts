import { createApp } from "./app.js";
import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { closePool, getPool } from "./db/pool.js";

async function main(): Promise<void> {
  const pool = getPool();
  await runMigrations(pool);

  const app = createApp({ pool });
  app.listen(config.port, "0.0.0.0", () => {
    console.log(`API listening on :${config.port}`);
  });
}

if (process.env.NODE_ENV !== "test") {
  main().catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
}

export { createApp };
