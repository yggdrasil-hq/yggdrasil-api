import type { JobScreenshotRepository } from "./repository.js";

/**
 * Issue #22's retention sweep, mirroring ADR 029's for recordings.
 *
 * Runs in-process in the API, following ADR 026's test scheduler: it is a single
 * indexed `UPDATE`, it needs no coordination beyond the idempotent predicate, and
 * standing up a separate service to run it would cost more operationally than the
 * job it performs. Several replicas may each run one — safe by construction
 * rather than by there being one instance, because `purgeExpired` only touches
 * rows that still hold bytes, so the second replica to run finds nothing.
 *
 * **Its own sweep rather than sharing the recordings'.** The two intervals would
 * almost always agree, but sharing one would silently couple two retention
 * policies that the schema deliberately keeps independent (screenshots are three
 * orders of magnitude smaller, so a project may reasonably keep them longer) —
 * and the first time someone raises one window, the other's sweep would either
 * run far too often or stop running at all.
 *
 * The interval is coarse on purpose. Retention is measured in days, so the
 * resolution of this ticker has no bearing on correctness, and a rare sweep keeps
 * the write off the hot path entirely.
 */
export interface ScreenshotSweepLogger {
  (message: string): void;
}

export async function sweepExpiredScreenshots(
  screenshots: JobScreenshotRepository,
  log: ScreenshotSweepLogger = () => {},
): Promise<number> {
  const purged = await screenshots.purgeExpired();
  if (purged > 0) {
    // Logged rather than silent: a sweep that runs is the only evidence that
    // retention is wired up at all, and this is the line an operator looks for
    // when asking "is anything actually being deleted".
    log(`screenshots: reclaimed ${purged} expired screenshot(s)`);
  }
  return purged;
}

/**
 * Starts the interval. Returns a stop function so a caller (a test, or a graceful
 * shutdown) can end it without reaching into the timer.
 *
 * A failing sweep is logged and swallowed: retention being late is a storage
 * cost, whereas an exception escaping the ticker would take the process down and
 * make every other request fail. `running` guards against overlap, so a sweep
 * that outlasts its interval cannot stack up.
 *
 * The first tick is immediate, matching the recordings sweep: a fresh install
 * should not wait a full interval to learn whether the sweep works at all.
 */
export function startScreenshotSweep(
  screenshots: JobScreenshotRepository,
  intervalMs: number,
  log: ScreenshotSweepLogger = () => {},
): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepExpiredScreenshots(screenshots, log);
    } catch (error) {
      log(
        `screenshots: sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
