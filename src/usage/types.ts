import type { JobKind } from "../jobs/types.js";
import type { ModelConfigSource } from "../model-config/types.js";

/**
 * ADR 023: one job's token/cost accounting, as reported by the Orchestrator
 * from Pi's own `get_session_stats`.
 *
 * Every count is provider-reported. Yggdrasil never tokenizes or estimates, so
 * these figures are only ever as accurate as the provider that billed them.
 *
 * `costUsd` is `null` when the provider reported no cost — deliberately
 * distinct from `0`, which is a real, useful fact about a free model.
 * `durationMs` is the cumulative time the agent spent working inside Pi turns,
 * excluding time a spec_grill sat waiting for a human reply; a null means the
 * Orchestrator did not report one.
 */
export interface JobUsage {
  jobId: string;
  projectId: string;
  jobKind: JobKind;
  /**
   * The literal model-id string the job actually ran with (the pod's own
   * `MODEL_ID`), which is ground truth: it records what served the run even if
   * the organization's configuration changed underneath it mid-run.
   */
  modelId: string | null;
  /**
   * Which model config tier won at report time (ADR 018 / its amendment),
   * resolved server-side so the Orchestrator never needs to know provider
   * names. `null` for a job kind that resolves no model config.
   */
  modelConfigSource: ModelConfigSource | null;
  /**
   * The catalog provider's name, when the winning tier is catalog-based.
   * `null` for the two custom-triplet tiers — those point at a
   * bring-your-own endpoint that no catalog row describes, so the provider is
   * genuinely unknowable rather than merely unresolved.
   */
  providerName: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: Date;
}

/** One aggregation bucket: a total plus how many sessions produced it. */
export interface UsageBucket {
  tokens: number;
  sessions: number;
}

export interface UsageByProvider extends UsageBucket {
  providerName: string | null;
  costUsd: number | null;
}

export interface UsageByKind extends UsageBucket {
  jobKind: JobKind;
}

export interface UsageByProject extends UsageBucket {
  projectId: string;
  projectName: string;
}

export interface UsageByModel extends UsageBucket {
  modelId: string | null;
  providerName: string | null;
}

/** One day of activity. Days with no usage are simply absent — the Web app fills the grid. */
export interface UsageActivityDay {
  date: string;
  sessions: number;
  tokens: number;
}

/** One recent job session, for the analytics table. */
export interface UsageSession {
  jobId: string;
  projectId: string;
  projectName: string;
  jobKind: JobKind;
  /** Feature title / test name / design name, whichever this job kind has. */
  title: string | null;
  featureId: string | null;
  testId: string | null;
  status: string;
  tokens: number;
  costUsd: number | null;
  durationMs: number | null;
  createdAt: Date;
}

/**
 * A window's headline totals. `previous*` describe the immediately preceding
 * window of the same length, so a caller can compute a period-over-period
 * change without a second request.
 */
export interface UsageTotals {
  sessions: number;
  tokens: number;
  costUsd: number | null;
  previousSessions: number;
  previousTokens: number;
}

export interface OrganizationUsageReport {
  days: number;
  from: string;
  to: string;
  totals: UsageTotals;
  byProvider: UsageByProvider[];
  byKind: UsageByKind[];
  byProject: UsageByProject[];
}

export interface OrganizationAnalyticsReport {
  days: number;
  from: string;
  to: string;
  totals: UsageTotals;
  activity: UsageActivityDay[];
  byKind: UsageByKind[];
  byProject: UsageByProject[];
  byModel: UsageByModel[];
  recentSessions: UsageSession[];
}

export interface ProjectUsageReport {
  days: number;
  from: string;
  to: string;
  totals: UsageTotals;
  byProvider: UsageByProvider[];
  byKind: UsageByKind[];
}

export interface ProjectAnalyticsReport {
  days: number;
  from: string;
  to: string;
  totals: UsageTotals;
  activity: UsageActivityDay[];
  byKind: UsageByKind[];
  byModel: UsageByModel[];
  recentSessions: UsageSession[];
}

/**
 * `SUM()` over a nullable numeric column returns null when no row in the
 * group has a value — which is exactly the "nobody reported a cost" signal,
 * so it is preserved rather than coalesced to zero.
 */
export function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Postgres returns int8/numeric as strings (pg refuses to silently lose
 * precision), so every aggregate arrives as text and must be converted
 * explicitly. Token totals comfortably fit a JS number — they would have to
 * exceed 2^53, i.e. nine quadrillion tokens, to lose anything here.
 */
export function numberFromRow(value: unknown): number {
  return nullableNumber(value) ?? 0;
}
