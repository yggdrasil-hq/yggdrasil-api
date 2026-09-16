import type pg from "pg";
import type { AgentJobKind, JobModelDefault } from "./types.js";

interface JobDefaultRow {
  organization_id: string;
  job_kind: AgentJobKind;
  model_id: string;
  created_at: Date;
  updated_at: Date;
}

function mapJobDefault(row: JobDefaultRow): JobModelDefault {
  return {
    organizationId: row.organization_id,
    jobKind: row.job_kind,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** ADR 018: the model an Organization defaults to for each agent-driven job kind. */
export class JobModelDefaultRepository {
  constructor(private readonly db: pg.Pool) {}

  async listForOrganization(organizationId: string): Promise<JobModelDefault[]> {
    const result = await this.db.query<JobDefaultRow>(
      `SELECT organization_id, job_kind, model_id, created_at, updated_at
       FROM organization_job_model_defaults
       WHERE organization_id = $1`,
      [organizationId],
    );
    return result.rows.map(mapJobDefault);
  }

  async findForJobKind(organizationId: string, jobKind: AgentJobKind): Promise<JobModelDefault | null> {
    const result = await this.db.query<JobDefaultRow>(
      `SELECT organization_id, job_kind, model_id, created_at, updated_at
       FROM organization_job_model_defaults
       WHERE organization_id = $1 AND job_kind = $2`,
      [organizationId, jobKind],
    );
    return result.rows[0] ? mapJobDefault(result.rows[0]) : null;
  }

  async upsert(organizationId: string, jobKind: AgentJobKind, modelId: string): Promise<JobModelDefault> {
    const result = await this.db.query<JobDefaultRow>(
      `INSERT INTO organization_job_model_defaults (organization_id, job_kind, model_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, job_kind)
       DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = NOW()
       RETURNING organization_id, job_kind, model_id, created_at, updated_at`,
      [organizationId, jobKind, modelId],
    );
    return mapJobDefault(result.rows[0]);
  }

  async clear(organizationId: string, jobKind: AgentJobKind): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM organization_job_model_defaults WHERE organization_id = $1 AND job_kind = $2`,
      [organizationId, jobKind],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
