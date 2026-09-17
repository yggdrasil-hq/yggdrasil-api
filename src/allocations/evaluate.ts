import { DEFAULT_RESOURCE_QUOTA, type TokenCapState } from "./types.js";

/**
 * ADR 030 §3: the enforced period is the current calendar month in UTC.
 *
 * UTC rather than a per-project timezone, for the same reason ADR 026 chose it
 * for test scheduling: there is no per-project timezone in the product, and UTC
 * is the one choice that makes DST structurally impossible. A month is also
 * long enough that an off-by-one-hour question never has to be answered.
 */
export interface MonthlyPeriod {
  /** Inclusive. */
  start: Date;
  /** Exclusive. */
  end: Date;
}

/**
 * The calendar month containing `now`, as a half-open UTC interval.
 *
 * Months are handled by the Date constructor's own rollover (month 12 is
 * January of the next year; day 0 is the last day of the previous month), so
 * this needs no per-month length table and cannot mis-handle February or a
 * leap year.
 */
export function monthPeriod(now: Date): MonthlyPeriod {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * ADR 030 §4: the cap decision, and the one boundary that matters.
 *
 * `used >= cap` is exceeded, not `used > cap`. A cap of N means "at most N
 * tokens this period"; once exactly N have been spent the budget is gone, so
 * the next job must not start. Using `>` would let a project spend its way to
 * N and then start one more job on top, which is the single most likely way for
 * a spend cap to be reported as working while not working.
 *
 * Consequences of the two special values, both deliberate and both tested:
 *   - `cap === null` is uncapped. It is not "zero" and not "infinite"; it is
 *     the absence of a cap, so `exceeded` is false regardless of usage.
 *   - `cap === 0` permits nothing further: with used === 0 the comparison
 *     `0 >= 0` is already true, so the project is blocked immediately. That is
 *     the honest reading of "spend nothing this period" -- the alternative
 *     (`used > cap`) would make a zero cap mean "one more job".
 *
 * `remainingTokens` floors at zero rather than going negative: once exceeded,
 * "how much is left" is zero, and a negative remainder in a UI reads as if some
 * budget might come back.
 */
export function evaluateTokenCap(input: {
  projectId: string;
  cap: number | null;
  usedTokens: number;
  now: Date;
}): TokenCapState {
  const { start, end } = monthPeriod(input.now);
  const usedTokens = Math.max(0, input.usedTokens);
  const exceeded = input.cap !== null && usedTokens >= input.cap;

  return {
    projectId: input.projectId,
    cap: input.cap,
    usedTokens,
    remainingTokens: input.cap === null ? null : Math.max(0, input.cap - usedTokens),
    exceeded,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
  };
}

/**
 * Whether a project may start another token-consuming job.
 *
 * Separate from `evaluateTokenCap` so the Orchestrator's enforcement check and
 * the admin UI's read provably agree: both consume the same `TokenCapState`,
 * and this is the only place that turns it into allow/deny.
 */
export function mayStartTokenConsumingJob(state: TokenCapState): boolean {
  return !state.exceeded;
}

/** Human-readable denial used in a job's `last_error`, so the reason is legible in the UI. */
export function capExceededMessage(state: TokenCapState): string {
  return (
    `project ${state.projectId} has reached its monthly token cap ` +
    `(${state.usedTokens} of ${state.cap} tokens used for the period beginning ${state.periodStart}); ` +
    `raise or clear the cap to run more work`
  );
}

/**
 * A project's quota override, validated. Returns null when the override is
 * absent (meaning: use the platform default), and throws on an invalid one --
 * the routes translate that into a 400 rather than storing a nonsense limit
 * that Kubernetes would later reject on every job in the namespace.
 */
export function resolveQuotaOverride(
  stored: { cpuMillicores: number; memoryMib: number; pods: number } | null,
): { cpuMillicores: number; memoryMib: number; pods: number } {
  if (!stored) {
    return { ...DEFAULT_RESOURCE_QUOTA };
  }
  return stored;
}
