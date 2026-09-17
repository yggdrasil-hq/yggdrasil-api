import type pg from "pg";
import {
  DEFAULT_RESOURCE_QUOTA,
  type EffectiveProjectAllocation,
  type ProjectResourceQuota,
  type ProjectTokenCap,
} from "./types.js";

interface TokenCapRow {
  project_id: string;
  monthly_token_cap: string;
  updated_at: Date;
}

interface QuotaRow {
  project_id: string;
  cpu_millicores: number;
  memory_mib: number;
  pods: number;
  updated_at: Date;
}

function mapTokenCap(row: TokenCapRow): ProjectTokenCap {
  return {
    projectId: row.project_id,
    // int8 arrives as a string (pg refuses to silently lose precision); a token
    // cap is nowhere near 2^53, so converting is safe and keeps the API's
    // public shape a number.
    monthlyTokenCap: Number(row.monthly_token_cap),
    updatedAt: row.updated_at,
  };
}

function mapQuota(row: QuotaRow): ProjectResourceQuota {
  return {
    projectId: row.project_id,
    cpuMillicores: row.cpu_millicores,
    memoryMib: row.memory_mib,
    pods: row.pods,
    updatedAt: row.updated_at,
  };
}

/**
 * ADR 030's storage: per-project cap overrides, and the consumption read the
 * cap is evaluated against.
 *
 * Deliberately does not own a consumption counter. `tokensUsedInPeriod` sums
 * ADR 023's `job_usage` rows, which is what makes the cap unable to disagree
 * with the numbers `/usage` and `/analytics` already show for the same project
 * and window (ADR 030 §3).
 */
export class AllocationRepository {
  constructor(private readonly db: pg.Pool) {}

  async findTokenCap(projectId: string): Promise<ProjectTokenCap | null> {
    const result = await this.db.query<TokenCapRow>(
      "SELECT project_id, monthly_token_cap, updated_at FROM project_token_caps WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0];
    return row ? mapTokenCap(row) : null;
  }

  async findResourceQuota(projectId: string): Promise<ProjectResourceQuota | null> {
    const result = await this.db.query<QuotaRow>(
      `SELECT project_id, cpu_millicores, memory_mib, pods, updated_at
       FROM project_resource_quotas WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    return row ? mapQuota(row) : null;
  }

  /**
   * Every project in an organization with its effective limits, in one pass.
   *
   * A LEFT JOIN rather than a query per project: the allocations page renders
   * every project, so N queries would turn one page load into N round trips.
   */
  async listForOrganization(organizationId: string): Promise<
    Array<{
      projectId: string;
      projectName: string;
      cap: ProjectTokenCap | null;
      quota: ProjectResourceQuota | null;
    }>
  > {
    const result = await this.db.query<{
      id: string;
      name: string;
      monthly_token_cap: string | null;
      cap_updated_at: Date | null;
      cpu_millicores: number | null;
      memory_mib: number | null;
      pods: number | null;
      quota_updated_at: Date | null;
    }>(
      `SELECT p.id, p.name,
              c.monthly_token_cap, c.updated_at AS cap_updated_at,
              q.cpu_millicores, q.memory_mib, q.pods, q.updated_at AS quota_updated_at
       FROM projects p
       LEFT JOIN project_token_caps c ON c.project_id = p.id
       LEFT JOIN project_resource_quotas q ON q.project_id = p.id
       WHERE p.organization_id = $1
       ORDER BY p.name ASC`,
      [organizationId],
    );

    return result.rows.map((row) => ({
      projectId: row.id,
      projectName: row.name,
      cap:
        row.monthly_token_cap === null
          ? null
          : {
              projectId: row.id,
              monthlyTokenCap: Number(row.monthly_token_cap),
              updatedAt: row.cap_updated_at ?? new Date(0),
            },
      quota:
        row.cpu_millicores === null || row.memory_mib === null || row.pods === null
          ? null
          : {
              projectId: row.id,
              cpuMillicores: row.cpu_millicores,
              memoryMib: row.memory_mib,
              pods: row.pods,
              updatedAt: row.quota_updated_at ?? new Date(0),
            },
    }));
  }

  /**
   * Tokens this project has consumed since `from` (inclusive) up to `to`
   * (exclusive), per ADR 023's per-job accounting.
   *
   * COALESCE to 0 because SUM over no rows is NULL, and "no jobs ran" is
   * unambiguously zero consumption rather than an unknown. Served by
   * idx_job_usage_project_created_at.
   */
  async tokensUsedInPeriod(projectId: string, from: Date, to: Date): Promise<number> {
    const result = await this.db.query<{ tokens: string | null }>(
      `SELECT COALESCE(SUM(total_tokens), 0)::text AS tokens
       FROM job_usage
       WHERE project_id = $1 AND created_at >= $2 AND created_at < $3`,
      [projectId, from, to],
    );
    return Number(result.rows[0]?.tokens ?? 0);
  }

  /** Upsert: presence of a row is what makes the cap apply. */
  async setTokenCap(projectId: string, monthlyTokenCap: number): Promise<ProjectTokenCap> {
    const result = await this.db.query<TokenCapRow>(
      `INSERT INTO project_token_caps (project_id, monthly_token_cap)
       VALUES ($1, $2)
       ON CONFLICT (project_id) DO UPDATE
         SET monthly_token_cap = EXCLUDED.monthly_token_cap, updated_at = NOW()
       RETURNING project_id, monthly_token_cap, updated_at`,
      [projectId, monthlyTokenCap],
    );
    return mapTokenCap(result.rows[0]);
  }

  /** Clearing deletes the row: "no cap" must be the absence of a row, not a sentinel value. */
  async clearTokenCap(projectId: string): Promise<void> {
    await this.db.query("DELETE FROM project_token_caps WHERE project_id = $1", [projectId]);
  }

  async setResourceQuota(
    projectId: string,
    quota: { cpuMillicores: number; memoryMib: number; pods: number },
  ): Promise<ProjectResourceQuota> {
    const result = await this.db.query<QuotaRow>(
      `INSERT INTO project_resource_quotas (project_id, cpu_millicores, memory_mib, pods)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id) DO UPDATE
         SET cpu_millicores = EXCLUDED.cpu_millicores,
             memory_mib = EXCLUDED.memory_mib,
             pods = EXCLUDED.pods,
             updated_at = NOW()
       RETURNING project_id, cpu_millicores, memory_mib, pods, updated_at`,
      [projectId, quota.cpuMillicores, quota.memoryMib, quota.pods],
    );
    return mapQuota(result.rows[0]);
  }

  /** Clearing reverts the project to the platform defaults. */
  async clearResourceQuota(projectId: string): Promise<void> {
    await this.db.query("DELETE FROM project_resource_quotas WHERE project_id = $1", [projectId]);
  }
}

/** Re-exported so callers can render "no override" without importing two modules. */
export { DEFAULT_RESOURCE_QUOTA };
export type { EffectiveProjectAllocation };
