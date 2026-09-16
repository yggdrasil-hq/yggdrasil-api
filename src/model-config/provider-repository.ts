import type pg from "pg";
import { decrypt, encrypt } from "../secrets/encryption.js";
import type { OrgProvider, ProviderType } from "./types.js";

interface ProviderRow {
  id: string;
  organization_id: string;
  name: string;
  provider_type: ProviderType;
  base_url: string;
  encrypted_api_key: string;
  created_at: Date;
  updated_at: Date;
}

function mapProvider(row: ProviderRow): OrgProvider {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS =
  "id, organization_id, name, provider_type, base_url, encrypted_api_key, created_at, updated_at";

/** ADR 018: org-scoped named providers. Metadata never exposes the decrypted API key. */
export class OrgProviderRepository {
  constructor(private readonly db: pg.Pool) {}

  async listForOrganization(organizationId: string): Promise<OrgProvider[]> {
    const result = await this.db.query<ProviderRow>(
      `SELECT ${SELECT_COLUMNS} FROM organization_model_providers
       WHERE organization_id = $1
       ORDER BY name ASC`,
      [organizationId],
    );
    return result.rows.map(mapProvider);
  }

  async findById(organizationId: string, providerId: string): Promise<OrgProvider | null> {
    const result = await this.db.query<ProviderRow>(
      `SELECT ${SELECT_COLUMNS} FROM organization_model_providers
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, providerId],
    );
    return result.rows[0] ? mapProvider(result.rows[0]) : null;
  }

  async create(input: {
    organizationId: string;
    name: string;
    providerType: ProviderType;
    baseUrl: string;
    apiKey: string;
  }): Promise<OrgProvider> {
    const result = await this.db.query<ProviderRow>(
      `INSERT INTO organization_model_providers (organization_id, name, provider_type, base_url, encrypted_api_key)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [input.organizationId, input.name, input.providerType, input.baseUrl, encrypt(input.apiKey)],
    );
    return mapProvider(result.rows[0]);
  }

  /** `apiKey` is optional on update — omitting it keeps the existing key ("leave blank to keep"). */
  async update(
    organizationId: string,
    providerId: string,
    input: { name?: string; baseUrl?: string; apiKey?: string },
  ): Promise<OrgProvider | null> {
    const result = await this.db.query<ProviderRow>(
      `UPDATE organization_model_providers
       SET name = COALESCE($3, name),
           base_url = COALESCE($4, base_url),
           encrypted_api_key = COALESCE($5, encrypted_api_key),
           updated_at = NOW()
       WHERE organization_id = $1 AND id = $2
       RETURNING ${SELECT_COLUMNS}`,
      [
        organizationId,
        providerId,
        input.name ?? null,
        input.baseUrl ?? null,
        input.apiKey ? encrypt(input.apiKey) : null,
      ],
    );
    return result.rows[0] ? mapProvider(result.rows[0]) : null;
  }

  async delete(organizationId: string, providerId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM organization_model_providers WHERE organization_id = $1 AND id = $2`,
      [organizationId, providerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Decrypts in-memory. Only internal/resolution call sites reach this. */
  async decryptApiKey(providerId: string): Promise<string | null> {
    const result = await this.db.query<{ encrypted_api_key: string }>(
      `SELECT encrypted_api_key FROM organization_model_providers WHERE id = $1`,
      [providerId],
    );
    const row = result.rows[0];
    return row ? decrypt(row.encrypted_api_key) : null;
  }
}
