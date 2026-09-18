import { createServer } from "node:http";
import { createApp } from "./app.js";
import { SessionService } from "./auth/sessions.js";
import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { closePool, createListenerClient, getPool } from "./db/pool.js";
import { FeatureRepository } from "./features/repository.js";
import { JobEventRepository } from "./jobs/events-repository.js";
import { JobRepository } from "./jobs/repository.js";
import { PostgresDeltaPublisher } from "./live/deltas.js";
import { LiveHub } from "./live/hub.js";
import { startLiveRelay } from "./live/relay.js";
import { createLiveSocketServer } from "./live/socket.js";
import { ProjectRepository } from "./projects/repository.js";
import { JobRecordingRepository } from "./recordings/repository.js";
import { startRecordingSweep } from "./recordings/sweep.js";
import { JobScreenshotRepository } from "./screenshots/repository.js";
import { startScreenshotSweep } from "./screenshots/sweep.js";
import { startScheduler } from "./scheduling/scheduler.js";
import { createObjectStorage } from "./storage/client.js";
import { startTestingGateReconcile } from "./features/testing-gate-reconcile.js";
import { UserRepository } from "./users/repository.js";

async function main(): Promise<void> {
  const pool = getPool();
  await runMigrations(pool);

  const app = createApp({
    pool,
    // ADR 019 item 13: deltas reach the hub through Postgres, not directly, so
    // that every replica's sockets can be reached — see PostgresDeltaPublisher.
    live: new PostgresDeltaPublisher(pool, { onError: (message) => console.error(message) }),
  });
  // ADR 019: the live event socket is attached to the HTTP server rather than
  // to the Express app — a WebSocket upgrade is an HTTP event Express never
  // sees, so there is no router to mount. Building the server here (instead of
  // `app.listen`) is also what keeps `createApp` free of sockets: every test in
  // this repo builds an app and never opens a port.
  const server = createServer(app);

  const hub = new LiveHub();
  createLiveSocketServer({
    server,
    hub,
    sessions: new SessionService(pool),
    users: new UserRepository(pool),
    projects: new ProjectRepository(pool),
    features: new FeatureRepository(pool),
    onError: (message) => console.error(message),
  });
  // The listener is started here, not inside `createApp`, for the same reason
  // the scheduler and recording sweep below are: a subscription's lifetime is
  // the process's, and constructing an app must never open one.
  if (config.live.enabled) {
    startLiveRelay({
      clientFactory: createListenerClient,
      hub,
      jobEvents: new JobEventRepository(pool),
      retryDelayMs: config.live.retryDelayMs,
      onError: (message) => console.error(message),
    });
  }

  server.listen(config.port, "0.0.0.0", () => {
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

  // Issue #40: the Testing stage's second trigger. The ordinary one is the last
  // runner to submit its report; this resolves the case where nothing ever does,
  // which otherwise leaves a feature wedged in `testing` with no event to wake
  // it. On the same interval as the scheduler below it — both are "check the
  // database for work that time has made actionable" — and idempotent across
  // replicas for the same reason (see features/testing-gate-reconcile.ts).
  if (config.scheduler.enabled) {
    startTestingGateReconcile(
      {
        pool,
        features: new FeatureRepository(pool),
        jobs: new JobRepository(pool),
        projects: new ProjectRepository(pool),
      },
      config.scheduler.intervalMs,
      (message) => console.error(message),
    );
  }

  // ADR 029: retention for stored recordings. Anchored to the process like the
  // scheduler above, and safe with several replicas (the purge is idempotent).
  // Without this, "retention" would be a policy nothing enforces, and the
  // recordings table would grow without bound.
  // The sweeps need the same storage client the routes use, because reclaiming
  // an object-backed artifact is a delete against the bucket rather than an
  // UPDATE (issue #30) — a sweep constructed without it would tombstone rows
  // whose bytes it never removed.
  const sweepStorage = createObjectStorage(
    config.storage.configured ? config.storage : null,
  );

  if (config.recordings.enabled) {
    startRecordingSweep(
      new JobRecordingRepository(pool, sweepStorage),
      config.recordings.sweepIntervalMs,
      (message) => console.error(message),
    );
  }

  // Issue #22: the same retention discipline for per-step screenshots. Its own
  // sweep rather than sharing the recordings' one — the two windows are
  // deliberately independent (screenshots are three orders of magnitude smaller,
  // so a project may keep them longer), and a shared ticker would couple them so
  // that raising one silently changed the other's cadence.
  if (config.screenshots.enabled) {
    startScreenshotSweep(
      new JobScreenshotRepository(pool, sweepStorage),
      config.screenshots.sweepIntervalMs,
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
