import type pg from "pg";
import type { OrgModel, ProviderType } from "./types.js";

interface ModelRow {
  id: string;
  organization_id: string;
  provider_id: string;
  provider_name: string;
  provider_type: ProviderType;
  display_name: string;
  model_id: string;
  created_at: Date;
  updated_at: Date;
}

function mapModel(row: ModelRow): OrgModel {
  return {
    id: row.id,
    organizationId: row.organization_id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    providerType: row.provider_type,
    displayName: row.display_name,
    modelId: row.model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_JOINED = `
  SELECT m.id, m.organization_id, m.provider_id, p.name AS provider_name, p.provider_type,
         m.display_name, m.model_id, m.created_at, m.updated_at
  FROM organization_models m
  JOIN organization_model_providers p ON p.id = m.provider_id
`;

/** ADR 018: org-scoped model catalog, each model belonging to exactly one provider. */
export class OrgModelRepository {
  constructor(private readonly db: pg.Pool) {}

  async listForOrganization(organizationId: string): Promise<OrgModel[]> {
    const result = await this.db.query<ModelRow>(
      `${SELECT_JOINED} WHERE m.organization_id = $1 ORDER BY m.display_name ASC`,
      [organizationId],
    );
    return result.rows.map(mapModel);
  }

  async findById(organizationId: string, modelId: string): Promise<OrgModel | null> {
    const result = await this.db.query<ModelRow>(
      `${SELECT_JOINED} WHERE m.organization_id = $1 AND m.id = $2`,
      [organizationId, modelId],
    );
    return result.rows[0] ? mapModel(result.rows[0]) : null;
  }

  async create(input: {
    organizationId: string;
    providerId: string;
    displayName: string;
    modelId: string;
  }): Promise<OrgModel> {
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO organization_models (organization_id, provider_id, display_name, model_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [input.organizationId, input.providerId, input.displayName, input.modelId],
    );
    const created = await this.findById(input.organizationId, inserted.rows[0].id);
    if (!created) {
      throw new Error("Failed to load newly created model");
    }
    return created;
  }

  async update(
    organizationId: string,
    modelId: string,
    input: { displayName?: string; modelIdValue?: string },
  ): Promise<OrgModel | null> {
    await this.db.query(
      `UPDATE organization_models
       SET display_name = COALESCE($3, display_name),
           model_id = COALESCE($4, model_id),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, modelId, input.displayName ?? null, input.modelIdValue ?? null],
    );
    return this.findById(organizationId, modelId);
  }

  /** Throws (FK violation surfaces as a DB error) if this model is a job default, a project override, or a feature override — ADR 018 item 4, extended to the feature tier by the ADR 018 amendment (issue #5). */
  async delete(organizationId: string, modelId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM organization_models WHERE organization_id = $1 AND id = $2`,
      [organizationId, modelId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
