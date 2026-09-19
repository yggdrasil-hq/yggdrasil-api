import type { JobSessionRepository } from "./repository.js";

/**
 * ADR 032 item 4's retention sweep.
 *
 * Runs in-process in the API, following ADR 026's test scheduler and ADR 029's
 * recording sweep: it is an indexed `UPDATE` per backend, it needs no coordination
 * beyond the idempotent predicate, and standing up a separate service would cost
 * more operationally than the job it performs. Several replicas may each run one —
 * safe by construction rather than by there being one instance, because
 * `purgeExpired` only touches rows that still hold bytes, so the second replica to
 * run finds nothing.
 *
 * Interval is coarse on purpose, matching recordings: retention is measured in days,
 * so the resolution of this ticker has no bearing on correctness.
 */
export interface SessionSweepLogger {
  (message: string): void;
}

/**
 * `reclaimAll` is ADR 032 item 4's "zero means reclaim everything" — see
 * `JobSessionRepository.purgeExpired`, which is where the predicate lives. It is
 * threaded from config by the caller rather than read here, so this function stays
 * a policy-free operation on the repository and is testable without config.
 */
export async function sweepExpiredSessions(
  sessions: JobSessionRepository,
  log: SessionSweepLogger = () => {},
  reclaimAll = false,
): Promise<number> {
  const purged = await sessions.purgeExpired(50, reclaimAll);
  if (purged > 0) {
    // Logged rather than silent: a sweep that runs is the only evidence retention
    // is wired up at all, and this is the line an operator looks for when asking
    // "is anything actually being deleted".
    log(
      `sessions: reclaimed ${purged} expired session(s)` +
        (reclaimAll ? " (collection is switched off, so all are reclaimable)" : ""),
    );
  }
  return purged;
}

/**
 * Starts the interval. Returns a stop function so a caller (a test, or a graceful
 * shutdown) can end it without reaching into the timer.
 *
 * A failing sweep is logged and swallowed: retention being late is a storage cost,
 * whereas an exception escaping the ticker would take the process down and make
 * every other request fail. `running` guards against overlap, so a sweep that takes
 * longer than the interval cannot stack up.
 */
export function startSessionSweep(
  sessions: JobSessionRepository,
  intervalMs: number,
  log: SessionSweepLogger = () => {},
  reclaimAll = false,
): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepExpiredSessions(sessions, log, reclaimAll);
    } catch (error) {
      log(
        `sessions: sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
