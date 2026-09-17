import { createApp } from "./app.js";
import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { closePool, getPool } from "./db/pool.js";
import { JobRepository } from "./jobs/repository.js";
import { JobRecordingRepository } from "./recordings/repository.js";
import { startRecordingSweep } from "./recordings/sweep.js";
import { startScheduler } from "./scheduling/scheduler.js";

async function main(): Promise<void> {
  const pool = getPool();
  await runMigrations(pool);

  const app = createApp({ pool });
  app.listen(config.port, "0.0.0.0", () => {
    console.log(`API listening on :${config.port}`);
  });

  // ADR 026: the test-run scheduler. Started here rather than inside
  // `createApp`, so building an app (every test in this repo) never spawns a
  // background ticker, and so the ticker's lifetime is the process's. Several
  // API replicas may each run one — that is safe by construction (the claim
  // transaction's SKIP LOCKED, see scheduling/scheduler.ts), not by there being
  // only one instance.
  if (config.scheduler.enabled) {
    startScheduler(
      { pool, jobs: new JobRepository(pool) },
      config.scheduler.intervalMs,
      (message) => console.error(message),
    );
  }

  // ADR 029: retention for stored recordings. Anchored to the process like the
  // scheduler above, and safe with several replicas (the purge is idempotent).
  // Without this, "retention" would be a policy nothing enforces, and the
  // recordings table would grow without bound.
  if (config.recordings.enabled) {
    startRecordingSweep(
      new JobRecordingRepository(pool),
      config.recordings.sweepIntervalMs,
      (message) => console.error(message),
    );
  }
}

if (process.env.NODE_ENV !== "test") {
  main().catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
}

export { createApp };
