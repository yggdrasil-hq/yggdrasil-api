import type pg from "pg";
import type { AgentJobKind, FeatureJobModelOverride } from "./types.js";

interface OverrideRow {
  feature_id: string;
  job_kind: AgentJobKind;
  model_id: string;
  created_at: Date;
  updated_at: Date;
}

function mapOverride(row: OverrideRow): FeatureJobModelOverride {
  return {
    featureId: row.feature_id,
    jobKind: row.job_kind,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * ADR 018 amendment (issue #5): a feature's catalog-based override for one job
 * kind — the narrowest tier, mirroring ProjectModelOverrideRepository exactly.
 * Presence of a row means override; absence means inherit. A feature may
 * separately supply its own custom triplet (feature_model_secrets), which takes
 * precedence over this table — see secrets/model-config.ts.
 */
export class FeatureJobModelOverrideRepository {
  constructor(private readonly db: pg.Pool) {}

  async listForFeature(featureId: string): Promise<FeatureJobModelOverride[]> {
    const result = await this.db.query<OverrideRow>(
      `SELECT feature_id, job_kind, model_id, created_at, updated_at
       FROM feature_job_model_overrides
       WHERE feature_id = $1`,
      [featureId],
    );
    return result.rows.map(mapOverride);
  }

  async findForJobKind(featureId: string, jobKind: AgentJobKind): Promise<FeatureJobModelOverride | null> {
    const result = await this.db.query<OverrideRow>(
      `SELECT feature_id, job_kind, model_id, created_at, updated_at
       FROM feature_job_model_overrides
       WHERE feature_id = $1 AND job_kind = $2`,
      [featureId, jobKind],
    );
    return result.rows[0] ? mapOverride(result.rows[0]) : null;
  }

  async upsert(featureId: string, jobKind: AgentJobKind, modelId: string): Promise<FeatureJobModelOverride> {
    const result = await this.db.query<OverrideRow>(
      `INSERT INTO feature_job_model_overrides (feature_id, job_kind, model_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (feature_id, job_kind)
       DO UPDATE SET model_id = EXCLUDED.model_id, updated_at = NOW()
       RETURNING feature_id, job_kind, model_id, created_at, updated_at`,
      [featureId, jobKind, modelId],
    );
    return mapOverride(result.rows[0]);
  }

  async clear(featureId: string, jobKind: AgentJobKind): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM feature_job_model_overrides WHERE feature_id = $1 AND job_kind = $2`,
      [featureId, jobKind],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
