import type pg from "pg";
import type { AgentJobKind, ProjectJobModelOverride } from "./types.js";

interface OverrideRow {
  project_id: string;
  job_kind: AgentJobKind;
  model_id: string;
  created_at: Date;
  updated_at: Date;
}

function mapOverride(row: OverrideRow): ProjectJobModelOverride {
  return {
    projectId: row.project_id,
    jobKind: row.job_kind,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * ADR 018 item 5: a project's catalog-based override of its org's per-job-kind
 * default. Presence of a row means override; absence means inherit. A project
 * may separately supply its own custom triplet directly in project_secrets —
 * unrelated to this table, and takes precedence over it (see model-config.ts).
 */
export class ProjectModelOverrideRepository {
  constructor(private readonly db: pg.Pool) {}

  async listForProject(projectId: string): Promise<ProjectJobModelOverride[]> {
    const result = await this.db.query<OverrideRow>(
      `SELECT project_id, job_kind, model_id, created_at, updated_at
       FROM project_job_model_overrides
       WHERE project_id = $1`,
      [projectId],
    );
    return result.rows.map(mapOverride);
  }

  async findForJobKind(projectId: string, jobKind: AgentJobKind): Promise<ProjectJobModelOverride | null> {
    const result = await this.db.query<OverrideRow>(
      `SELECT project_id, job_kind, model_id, created_at, updated_at
       FROM project_job_model_overrides
       WHERE project_id = $1 AND job_kind = $2`,
      [projectId, jobKind],
    );
    return result.rows[0] ? mapOverride(result.rows[0]) : null;
  }

  async upsert(projectId: string, jobKind: AgentJobKind, modelId: string): Promise<ProjectJobModelOverride> {
    const result = await this.db.query<OverrideRow>(
      `INSERT INTO project_job_model_overrides (project_id, job_kind, model_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, job_kind)
       DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = NOW()
       RETURNING project_id, job_kind, model_id, created_at, updated_at`,
      [projectId, jobKind, modelId],
    );
    return mapOverride(result.rows[0]);
  }

  async clear(projectId: string, jobKind: AgentJobKind): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM project_job_model_overrides WHERE project_id = $1 AND job_kind = $2`,
      [projectId, jobKind],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
