import type pg from "pg";
import type { JobKind } from "../jobs/types.js";
import type { ModelConfigSource } from "../model-config/types.js";
import {
  nullableNumber,
  numberFromRow,
  type JobUsage,
  type OrganizationAnalyticsReport,
  type OrganizationUsageReport,
  type ProjectAnalyticsReport,
  type ProjectUsageReport,
  type UsageActivityDay,
  type UsageByKind,
  type UsageByModel,
  type UsageByProject,
  type UsageByProvider,
  type UsageSession,
  type UsageTotals,
} from "./types.js";

/**
 * The scope every aggregate is computed within. `projectId` narrows an
 * organization window to one project; `from`/`to` bound it in time.
 */
export interface UsageScope {
  organizationId: string;
  projectId?: string;
  from: Date;
  to: Date;
  /** Length of the window immediately preceding `from`, for period-over-period comparison. */
  previousFrom: Date;
  /** How many rows the analytics "recent sessions" list returns. */
  recentLimit: number;
}

/**
 * Both filters are expressed as SQL fragments sharing one placeholder-layout,
 * so every aggregate below provably reads the same rows: `$1` is the
 * organization, `$2` the optional project, `$3`/`$4` the window.
 *
 * The organization is joined through `projects` rather than stored on the
 * usage row (see migration 036): a project's organization is the project's
 * fact, not the job's, so joining keeps this correct even if that ever
 * changed. The project filter uses the job's own denormalized `project_id`.
 */
const SCOPE_PREDICATE = `
  p.organization_id = $1
  AND ($2::uuid IS NULL OR u.project_id = $2::uuid)
  AND u.created_at >= $3 AND u.created_at < $4
`;

interface TotalsRow {
  sessions: string;
  tokens: string | null;
  cost: string | null;
}

export class JobUsageRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Records (or re-records) one job's accounting. Idempotent on job_id so a
   * duplicate post from a restarted Orchestrator cannot double-count: the
   * figures are a whole-session snapshot, so a re-report replaces rather than
   * accumulates.
   *
   * organization_id is not stored; the caller has already resolved the job's
   * project, which is what the read path joins through.
   */
  async upsert(input: {
    jobId: string;
    projectId: string;
    jobKind: JobKind;
    modelId: string | null;
    modelConfigSource: ModelConfigSource | null;
    providerName: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    costUsd: number | null;
    durationMs: number | null;
  }): Promise<JobUsage> {
    const result = await this.db.query<UsageRow>(
      `INSERT INTO job_usage (
         job_id, project_id, job_kind, model_id, model_config_source, provider_name,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_tokens, cost_usd, duration_ms
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (job_id) DO UPDATE SET
         model_id = EXCLUDED.model_id,
         model_config_source = EXCLUDED.model_config_source,
         provider_name = EXCLUDED.provider_name,
         input_tokens = EXCLUDED.input_tokens,
         output_tokens = EXCLUDED.output_tokens,
         cache_read_tokens = EXCLUDED.cache_read_tokens,
         cache_write_tokens = EXCLUDED.cache_write_tokens,
         total_tokens = EXCLUDED.total_tokens,
         cost_usd = EXCLUDED.cost_usd,
         duration_ms = EXCLUDED.duration_ms
       RETURNING ${usageColumns}`,
      [
        input.jobId,
        input.projectId,
        input.jobKind,
        input.modelId,
        input.modelConfigSource,
        input.providerName,
        input.inputTokens,
        input.outputTokens,
        input.cacheReadTokens,
        input.cacheWriteTokens,
        input.totalTokens,
        input.costUsd,
        input.durationMs,
      ],
    );
    return mapUsage(result.rows[0]);
  }

  private scopeArgs(scope: UsageScope): unknown[] {
    return [scope.organizationId, scope.projectId ?? null, scope.from, scope.to];
  }

  /**
   * Headline totals for the window, plus the same totals for the preceding
   * window of equal length. Cost uses SUM over a nullable column, so it stays
   * null — "nobody reported a cost" — rather than reading as a real zero.
   */
  private async totals(scope: UsageScope): Promise<UsageTotals> {
    const result = await this.db.query<{
      sessions: string;
      tokens: string | null;
      cost: string | null;
      previous_sessions: string;
      previous_tokens: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE u.created_at >= $3 AND u.created_at < $4) AS sessions,
         SUM(u.total_tokens) FILTER (WHERE u.created_at >= $3 AND u.created_at < $4) AS tokens,
         SUM(u.cost_usd) FILTER (WHERE u.created_at >= $3 AND u.created_at < $4) AS cost,
         COUNT(*) FILTER (WHERE u.created_at >= $5 AND u.created_at < $3) AS previous_sessions,
         SUM(u.total_tokens) FILTER (WHERE u.created_at >= $5 AND u.created_at < $3) AS previous_tokens
       FROM job_usage u
       JOIN projects p ON p.id = u.project_id
       WHERE p.organization_id = $1
         AND ($2::uuid IS NULL OR u.project_id = $2::uuid)
         AND u.created_at >= $5 AND u.created_at < $4`,
      [...this.scopeArgs(scope), scope.previousFrom],
    );
    const row = result.rows[0];
    return {
      sessions: numberFromRow(row?.sessions),
      tokens: numberFromRow(row?.tokens),
      costUsd: nullableNumber(row?.cost ?? null),
      previousSessions: numberFromRow(row?.previous_sessions),
      previousTokens: numberFromRow(row?.previous_tokens),
    };
  }

  private async byProvider(scope: UsageScope): Promise<UsageByProvider[]> {
    const result = await this.db.query(
      `SELECT u.provider_name, SUM(u.total_tokens) AS tokens, COUNT(*) AS sessions,
              SUM(u.cost_usd) AS cost
       FROM job_usage u
       JOIN projects p ON p.id = u.project_id
       WHERE ${SCOPE_PREDICATE}
       GROUP BY u.provider_name
       ORDER BY SUM(u.total_tokens) DESC, u.provider_name ASC NULLS LAST`,
      this.scopeArgs(scope),
    );
    return result.rows.map((row) => ({
      providerName: (row.provider_name as string | null) ?? null,
      tokens: numberFromRow(row.tokens),
      sessions: numberFromRow(row.sessions),
      costUsd: nullableNumber(row.cost),
    }));
  }

  private async byKind(scope: UsageScope): Promise<UsageByKind[]> {
    const result = await this.db.query(
      `SELECT u.job_kind, SUM(u.total_tokens) AS tokens, COUNT(*) AS sessions
       FROM job_usage u
       JOIN projects p ON p.id = u.project_id
       WHERE ${SCOPE_PREDICATE}
       GROUP BY u.job_kind
       ORDER BY SUM(u.total_tokens) DESC, u.job_kind ASC`,
      this.scopeArgs(scope),
    );
    return result.rows.map((row) => ({
      jobKind: row.job_kind as JobKind,
      tokens: numberFromRow(row.tokens),
      sessions: numberFromRow(row.sessions),
    }));
  }

  private async byProject(scope: UsageScope): Promise<UsageByProject[]> {
    const result = await this.db.query(
      `SELECT p.id AS project_id, p.name AS project_name,
              SUM(u.total_tokens) AS tokens, COUNT(*) AS sessions
       FROM job_usage u
       JOIN projects p ON p.id = u.project_id
       WHERE ${SCOPE_PREDICATE}
       GROUP BY p.id, p.name
       ORDER BY SUM(u.total_tokens) DESC, p.name ASC`,
      this.scopeArgs(scope),
    );
    return result.rows.map((row) => ({
      projectId: row.project_id as string,
      projectName: row.project_name as string,
      tokens: numberFromRow(row.tokens),
      sessions: numberFromRow(row.sessions),
    }));
  }

  private async byModel(scope: UsageScope): Promise<UsageByModel[]> {
    const result = await this.db.query(
      `SELECT u.model_id, u.provider_name, SUM(u.total_tokens) AS tokens, COUNT(*) AS sessions
       FROM job_usage u
       JOIN projects p ON p.id = u.project_id
       WHERE ${SCOPE_PREDICATE}
       GROUP BY u.model_id, u.provider_name
       ORDER BY SUM(u.total_tokens) DESC, u.model_id ASC NULLS LAST`,
      this.scopeArgs(scope),
    );
    return result.rows.map((row) => ({
      modelId: (row.model_id as string | null) ?? null,
      providerName: (row.provider_name as string | null) ?? null,
      tokens: numberFromRow(row.tokens),
      sessions: numberFromRow(row.sessions),
    }));
  }

  /**
   * Sessions per day over the window. Only days that saw usage come back —
   * the Web app fills the rest of its grid — and days are bucketed in UTC so
   * the same date means the same thing for every reader regardless of where
   * the API happens to run.
   */
  private async activity(scope: UsageScope): Promise<UsageActivityDay[]> {
    const result = await this.db.query(
      `SELECT to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              COUNT(*) AS sessions, SUM(u.total_tokens) AS tokens
       FROM job_usage u
       JOIN projects p ON p.id = u.project_id
       WHERE ${SCOPE_PREDICATE}
       GROUP BY day
       ORDER BY day ASC`,
      this.scopeArgs(scope),
    );
    return result.rows.map((row) => ({
      date: row.day as string,
      sessions: numberFromRow(row.sessions),
      tokens: numberFromRow(row.tokens),
    }));
  }

  /**
   * The most recent sessions, each labelled with whatever its kind actually
   * has — a feature title, a test name, or a design name — resolved from the
   * job row rather than guessed.
   */
  private async recentSessions(scope: UsageScope): Promise<UsageSession[]> {
    const result = await this.db.query(
      `SELECT u.job_id, u.project_id, p.name AS project_name, u.job_kind,
              u.total_tokens, u.cost_usd, u.duration_ms, u.created_at,
              j.status, j.feature_id, j.test_id, j.design_name,
              f.title AS feature_title, t.name AS test_name
       FROM job_usage u
       JOIN projects p ON p.id = u.project_id
       JOIN jobs j ON j.id = u.job_id
       LEFT JOIN features f ON f.id = j.feature_id
       LEFT JOIN tests t ON t.id = j.test_id
       WHERE ${SCOPE_PREDICATE}
       ORDER BY u.created_at DESC
       LIMIT $5`,
      [...this.scopeArgs(scope), scope.recentLimit],
    );
    return result.rows.map((row) => ({
      jobId: row.job_id as string,
      projectId: row.project_id as string,
      projectName: row.project_name as string,
      jobKind: row.job_kind as JobKind,
      title:
        (row.feature_title as string | null) ??
        (row.test_name as string | null) ??
        (row.design_name as string | null) ??
        null,
      featureId: (row.feature_id as string | null) ?? null,
      testId: (row.test_id as string | null) ?? null,
      status: row.status as string,
      tokens: numberFromRow(row.total_tokens),
      costUsd: nullableNumber(row.cost_usd),
      durationMs: nullableNumber(row.duration_ms),
      createdAt: row.created_at as Date,
    }));
  }

  async organizationUsage(scope: UsageScope): Promise<OrganizationUsageReport> {
    const [totals, byProvider, byKind, byProject] = await Promise.all([
      this.totals(scope),
      this.byProvider(scope),
      this.byKind(scope),
      this.byProject(scope),
    ]);
    return {
      days: daysBetween(scope.from, scope.to),
      from: scope.from.toISOString(),
      to: scope.to.toISOString(),
      totals,
      byProvider,
      byKind,
      byProject,
    };
  }

  async organizationAnalytics(scope: UsageScope): Promise<OrganizationAnalyticsReport> {
    const [totals, activity, byKind, byProject, byModel, recentSessions] = await Promise.all([
      this.totals(scope),
      this.activity(scope),
      this.byKind(scope),
      this.byProject(scope),
      this.byModel(scope),
      this.recentSessions(scope),
    ]);
    return {
      days: daysBetween(scope.from, scope.to),
      from: scope.from.toISOString(),
      to: scope.to.toISOString(),
      totals,
      activity,
      byKind,
      byProject,
      byModel,
      recentSessions,
    };
  }

  async projectUsage(scope: UsageScope): Promise<ProjectUsageReport> {
    const [totals, byProvider, byKind] = await Promise.all([
      this.totals(scope),
      this.byProvider(scope),
      this.byKind(scope),
    ]);
    return {
      days: daysBetween(scope.from, scope.to),
      from: scope.from.toISOString(),
      to: scope.to.toISOString(),
      totals,
      byProvider,
      byKind,
    };
  }

  async projectAnalytics(scope: UsageScope): Promise<ProjectAnalyticsReport> {
    const [totals, activity, byKind, byModel, recentSessions] = await Promise.all([
      this.totals(scope),
      this.activity(scope),
      this.byKind(scope),
      this.byModel(scope),
      this.recentSessions(scope),
    ]);
    return {
      days: daysBetween(scope.from, scope.to),
      from: scope.from.toISOString(),
      to: scope.to.toISOString(),
      totals,
      activity,
      byKind,
      byModel,
      recentSessions,
    };
  }
}

const usageColumns = `
  job_id, project_id, job_kind, model_id, model_config_source, provider_name,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, cost_usd, duration_ms, created_at
`;

interface UsageRow {
  job_id: string;
  project_id: string;
  job_kind: JobKind;
  model_id: string | null;
  model_config_source: ModelConfigSource | null;
  provider_name: string | null;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_read_tokens: string | number;
  cache_write_tokens: string | number;
  total_tokens: string | number;
  cost_usd: string | null;
  duration_ms: string | null;
  created_at: Date;
}

function mapUsage(row: UsageRow): JobUsage {
  return {
    jobId: row.job_id,
    projectId: row.project_id,
    jobKind: row.job_kind,
    modelId: row.model_id,
    modelConfigSource: row.model_config_source,
    providerName: row.provider_name,
    inputTokens: numberFromRow(row.input_tokens),
    outputTokens: numberFromRow(row.output_tokens),
    cacheReadTokens: numberFromRow(row.cache_read_tokens),
    cacheWriteTokens: numberFromRow(row.cache_write_tokens),
    totalTokens: numberFromRow(row.total_tokens),
    costUsd: nullableNumber(row.cost_usd),
    durationMs: nullableNumber(row.duration_ms),
    createdAt: row.created_at,
  };
}

/** Whole days covered by the window, used only to report back what was asked. */
function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}
