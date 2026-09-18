import type pg from "pg";
import type { JobKind } from "./types.js";

/**
 * Issue #63: what this installation can actually run.
 *
 * `submit_build_result` dispatches a `script_test_run` probe for `unit` and
 * `integration` on every feature, and neither can run on an install with no
 * `SCRIPT_TEST_RUN_IMAGE` — two wasted job rows per feature, and every feature
 * fails at Testing because nothing was able to verify it (#44, #53). The API has
 * no way to know that today: the images live in the Orchestrator's environment
 * and nothing carries that fact to the API.
 *
 * This module is the API's read side of the channel that fixes it. The write side
 * is the Orchestrator's, and **until it publishes, this reports "unknown", which
 * is treated as capable** — exactly the pre-#63 behaviour, so the seam is safe to
 * land ahead of its producer.
 *
 * See `db/migrations/050_job_kind_capabilities.sql` for why the channel is a
 * table in the shared database rather than an HTTP endpoint.
 */

/**
 * How long a worker's claim about its own capabilities is trusted.
 *
 * A row is a statement about a *running* installation, and installations change:
 * an operator adds the missing image, or the Orchestrator is replaced by a
 * differently-configured one. Without an expiry, a single report would pin the
 * API's behaviour forever — including after the problem it describes was fixed,
 * which is the failure mode that makes a stale-capability cache worse than no
 * cache at all.
 *
 * Fifteen minutes is deliberately well above the reporting interval a worker can
 * reasonably use (it needs only to out-live a restart) and well below the time
 * over which an operator would notice a change they just made. Past it a kind
 * reverts to "unknown" ⇒ capable ⇒ today's behaviour, so the failure direction is
 * "dispatch a probe that turns out to be skippable", never "silently skip
 * testing".
 */
export const CAPABILITY_TRUST_MS = 15 * 60 * 1000;

/**
 * The API's view of what the installation can run.
 *
 * An interface rather than the repository class directly so the dispatch path can
 * take the null object below — the many tests that construct the jobs router
 * without a database keep working, and a deployment whose Orchestrator does not
 * publish behaves identically to one from before this existed.
 */
export interface JobKindCapabilities {
  /** Job kinds this installation has reported it cannot run. Empty when unknown. */
  unrunnable(): Promise<ReadonlySet<JobKind>>;
}

/**
 * "Nothing is known to be unrunnable", which is the correct default twice over:
 * it preserves the behaviour of every install until the Orchestrator publishes,
 * and it errs toward *dispatching* — a probe that cannot run is visible and
 * recoverable (it is reported, and #53 made the gate fail rather than advance on
 * it), whereas one that was never dispatched fails silently in the direction of
 * "there was nothing to check".
 */
export const UNKNOWN_CAPABILITIES: JobKindCapabilities = {
  async unrunnable() {
    return new Set<JobKind>();
  },
};

export class JobKindCapabilityRepository implements JobKindCapabilities {
  constructor(
    private readonly db: pg.Pool,
    private readonly trustMs: number = CAPABILITY_TRUST_MS,
  ) {}

  /**
   * The kinds a *currently running* worker has reported it cannot run.
   *
   * Returns only the negative claims: a kind with no row, or a row that has gone
   * stale, is unknown rather than capable-in-fact, and every caller treats
   * unknown the same way (dispatch it). Reading only the negatives keeps the
   * table's meaning narrow — "this worker said it could not run X" — instead of
   * turning it into a complete inventory that must be kept accurate.
   */
  async unrunnable(): Promise<ReadonlySet<JobKind>> {
    const cutoff = new Date(Date.now() - this.trustMs);
    const result = await this.db.query<{ job_kind: JobKind }>(
      `SELECT job_kind
         FROM job_kind_capabilities
        WHERE runnable = FALSE
          AND reported_at >= $1`,
      [cutoff],
    );
    return new Set(result.rows.map((row) => row.job_kind));
  }
}
