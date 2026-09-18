import type pg from "pg";
import type { FeatureRepository } from "./repository.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { TestRunReportRepository } from "../tests/reports-repository.js";
import { evaluateTestingGate, type TestingGateDeps } from "./testing-gate-runner.js";

/**
 * ADR 015 items 9-12, issue #40: the Testing stage's second trigger.
 *
 * The ordinary trigger is the last runner to submit its report
 * (`submit_test_report` in `jobs/internal-routes.ts`). This tick exists because
 * that trigger **cannot fire when nothing reports**: a `script_test_run` whose
 * container never started — an unconfigured image, a crash, a runner that exits
 * without submitting — leaves the feature sitting in `testing` with no event to
 * wake the gate up, so it never returns and never advances. That was the
 * observed failure: a feature whose every test run had failed hours earlier was
 * still showing "testing is still running".
 *
 * **Why here and not in the event handler.** The API cannot be told "the pod
 * died" — the Orchestrator fails the job in the shared database and tells
 * nobody. But the API can *read* that, and it already runs a periodic ticker
 * (`scheduling/scheduler.ts`), so the missing signal becomes a poll instead of
 * a new cross-service contract.
 *
 * **Several replicas are safe.** Evaluation is idempotent by construction: a
 * decision moves the feature out of `testing`, and the gate re-reads the status
 * before applying anything, so two replicas deciding the same feature
 * concurrently produce one transition. The candidate query is only a bounded
 * pre-filter — no locks, no claim — because unlike the scheduler's dispatch this
 * work has no side effect that would be duplicated, so the machinery that makes
 * double-firing harmless there would be pure overhead here.
 */

/** How many features one tick will look at, bounded like `MAX_CANDIDATES_PER_TICK`. */
export const MAX_TESTING_GATE_CANDIDATES = 25;

export interface TestingGateTickResult {
  /** Features the pre-filter offered. */
  candidates: number;
  /** Decisions actually applied (advanced / returned / errored). */
  applied: number;
}

export interface TestingGateSchedulerDeps extends TestingGateDeps {
  pool: pg.Pool;
}

/** One reconcile tick. `now`-free: nothing here is schedule- or clock-driven. */
export async function runTestingGateTick(
  deps: TestingGateSchedulerDeps,
  limit: number = MAX_TESTING_GATE_CANDIDATES,
): Promise<TestingGateTickResult> {
  const candidates = await deps.features.listTestingWithTerminalRuns(limit);
  const result: TestingGateTickResult = { candidates: candidates.length, applied: 0 };

  for (const candidate of candidates) {
    // One feature's failure must not abandon the rest of the pass: a stale
    // project row or a transient error on feature 3 would otherwise leave
    // features 4..N stuck for as long as it persists, which is the exact
    // failure this tick exists to prevent.
    try {
      const outcome = await evaluateTestingGate(deps, candidate.projectId, candidate.id);
      if (
        outcome.outcome === "advanced" ||
        outcome.outcome === "returned" ||
        outcome.outcome === "errored"
      ) {
        result.applied += 1;
      }
    } catch (error) {
      // Swallowed so the loop continues, but loud: the feature stays in
      // `testing` and the next tick retries it.
      console.error(
        `testing gate: failed to evaluate feature ${candidate.id}:`,
        error,
      );
    }
  }

  return result;
}

/**
 * Runs `runTestingGateTick` on a fixed interval, mirroring `startScheduler`:
 * self-overlap is skipped rather than queued, a failed tick is logged and
 * swallowed, and the timer does not hold the process open on shutdown.
 */
export function startTestingGateReconcile(
  deps: { pool: pg.Pool } & Omit<TestingGateSchedulerDeps, "testRunReports">,
  intervalMs: number,
  log: (message: string) => void = console.error,
): () => void {
  const withReports: TestingGateSchedulerDeps = {
    ...deps,
    testRunReports: new TestRunReportRepository(deps.pool),
  };

  let running = false;

  const timer = setInterval(() => {
    if (running) {
      log("testing gate: previous tick still running, skipping this interval");
      return;
    }
    running = true;
    void runTestingGateTick(withReports)
      .then((result) => {
        if (result.applied > 0) {
          log(`testing gate: resolved ${result.applied} stuck Testing stage(s)`);
        }
      })
      .catch((error: unknown) => {
        log(`testing gate: tick failed: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref?.();

  return () => clearInterval(timer);
}
