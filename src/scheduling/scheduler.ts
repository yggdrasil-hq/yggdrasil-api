import type pg from "pg";
import { isDueForSchedule } from "./cron.js";
import { TestScheduleRepository, type DueCandidate } from "./repository.js";
import type { JobRepository } from "../jobs/repository.js";

/**
 * ADR 026: the test-run scheduler.
 *
 * **Why it lives in the API process.** The `tests` entity, its cron
 * expressions, `last_run_at`, and the job rows a schedule produces are all
 * API-owned — the Orchestrator never reads or writes any of them; it only
 * claims already-created jobs from the queue. Putting the tick in the
 * Orchestrator would mean adding a second writer of `tests` (the component
 * whose whole design premise is being stateless, ADR 003 §19-20), and putting
 * it in its own service would add a deployable for one query loop. So the API
 * starts it alongside the HTTP listener (`index.ts`), and deliberately *not*
 * in `app.ts`, so tests that build an app never spawn a background ticker.
 *
 * **Several replicas are safe.** The API runs 2+ replicas in the same way the
 * Orchestrator does, so a naive "select due tests, then dispatch" would
 * double-fire every test. The claim is instead a transaction holding
 * `FOR UPDATE OF t SKIP LOCKED` on the candidate rows (see
 * `TestScheduleRepository.listCandidates`), which is the job queue's own
 * precedent (ADR 003 §18): concurrent ticks partition the work instead of
 * racing for it, and the job insert plus the `last_run_at` write commit
 * together, so a replica that dies mid-tick leaves the test unadvanced rather
 * than half-dispatched.
 */

/**
 * How many tests one tick will consider. Bounded so a large install cannot hold
 * row locks for an unbounded time; a backlog drains over successive ticks
 * rather than in one long transaction. Ordered longest-since-run first, so the
 * tests that have waited longest are claimed first.
 */
export const MAX_CANDIDATES_PER_TICK = 100;

export interface SchedulerDeps {
  pool: pg.Pool;
  jobs: JobRepository;
}

export interface SchedulerTickResult {
  /** Rows the SQL pre-filter offered; the due-check then narrows these. */
  candidates: number;
  /** Jobs created for due tests on runnable projects. */
  dispatched: number;
  /** Due, but the won't-run-now check below skipped the dispatch. */
  skippedProjectNotRunnable: number;
  /** Offered by the pre-filter but not actually due — cron math said no. */
  skippedNotDue: number;
}

/**
 * One scheduler tick.
 *
 * `now` is a parameter rather than a `new Date()` inside, so the whole tick
 * reasons about a single instant: a slow tick cannot see a different time for
 * its candidate query than for its due-check, which would let a test be judged
 * due and then stamped with a time that makes it look not-yet-due.
 */
export async function runSchedulerTick(
  deps: SchedulerDeps,
  now: Date = new Date(),
): Promise<SchedulerTickResult> {
  const client = await deps.pool.connect();
  const result: SchedulerTickResult = {
    candidates: 0,
    dispatched: 0,
    skippedProjectNotRunnable: 0,
    skippedNotDue: 0,
  };

  try {
    await client.query("BEGIN");

    const schedule = new TestScheduleRepository(client);
    const candidates = await schedule.listCandidates(now, MAX_CANDIDATES_PER_TICK);
    result.candidates = candidates.length;

    const due = candidates.filter((candidate) => {
      const isDue = isDueForSchedule({
        expression: candidate.scheduleCron,
        lastRunAt: candidate.lastRunAt,
        createdAt: candidate.createdAt,
        now,
        // Issue #31 part 1: the project's own zone. `null` for a project that has
        // not set one, which is the pre-#31 behaviour, and `isDueForSchedule`
        // resolves an unusable stored value to UTC rather than throwing — a bad
        // setting must not abort the tick for every other project.
        timeZone: candidate.scheduleTimeZone,
      });
      if (!isDue) result.skippedNotDue += 1;
      return isDue;
    });

    for (const candidate of due) {
      if (!isProjectRunnable(candidate)) {
        // Skip without advancing `last_run_at`: the schedule stays overdue, so
        // the run happens as soon as the operator clears whichever warning is
        // set. That is the desired catch-up — the alternative, treating the
        // skip as "ran", would silently drop the run entirely.
        result.skippedProjectNotRunnable += 1;
        continue;
      }

      await dispatchScheduledRun(deps, client, candidate);
      await schedule.markScheduledAt(candidate.testId, now);
      result.dispatched += 1;
    }

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Whether a project can run a job at all right now. Both conditions already
 * have their own action-queue item and banner in the Web app, so this only
 * decides not to spend a container on a run that would fail on arrival.
 */
function isProjectRunnable(candidate: DueCandidate): boolean {
  return (
    !candidate.projectModelConfigWarning && !candidate.projectGithubAccessWarning
  );
}

/**
 * `trigger: "schedule"` is what distinguishes a scheduled run from a
 * feature-driven one in the job row, and `ref: "main"` is the standalone
 * Testing product's target: a schedule verifies the project's default branch,
 * whereas ADR 015's feature Testing runs against a feature branch.
 *
 * Written through `JobRepository.create` with the tick's own client so the job
 * row and the `last_run_at` stamp commit as one unit.
 */
async function dispatchScheduledRun(
  deps: SchedulerDeps,
  client: pg.PoolClient,
  candidate: DueCandidate,
): Promise<void> {
  await deps.jobs.create(
    {
      projectId: candidate.projectId,
      kind: "test_run",
      testId: candidate.testId,
      ref: "main",
      trigger: "schedule",
    },
    client,
  );
}

/**
 * Runs `runSchedulerTick` on a fixed interval and returns a stop function.
 *
 * Self-overlap is prevented rather than queued: if a tick is still running when
 * the next interval elapses (a slow database, a large backlog), the next one is
 * skipped entirely instead of stacking — the following interval picks the work
 * up, and the claim transaction makes a skipped tick harmless.
 *
 * A failed tick is logged and swallowed. A scheduler that crashed the API
 * process on a transient database error would take the whole control plane down
 * with it, and the work it missed is picked up by the same catch-up path as any
 * other missed window.
 */
export function startScheduler(
  deps: SchedulerDeps,
  intervalMs: number,
  log: (message: string) => void = console.error,
): () => void {
  let running = false;

  const timer = setInterval(() => {
    if (running) {
      log("scheduler: previous tick still running, skipping this interval");
      return;
    }
    running = true;
    void runSchedulerTick(deps)
      .then((result) => {
        if (result.dispatched > 0) {
          log(
            `scheduler: dispatched ${result.dispatched} scheduled test run(s)`,
          );
        }
      })
      .catch((error: unknown) => {
        log(`scheduler: tick failed: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // Don't hold the process open on shutdown purely for the ticker.
  timer.unref?.();

  return () => clearInterval(timer);
}
