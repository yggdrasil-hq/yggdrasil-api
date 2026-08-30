import type pg from "pg";
import { decrypt, encrypt } from "../secrets/encryption.js";
import type { ProjectSecretMetadata } from "../secrets/types.js";

interface OrgSecretRow {
  id: string;
  organization_id: string;
  key_name: string;
  encrypted_value: string;
  created_at: Date;
  updated_at: Date;
}

function mapMetadata(row: OrgSecretRow): ProjectSecretMetadata {
  return {
    id: row.id,
    key: row.key_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * ADR 016 items 8-10: org-level provider/secret config, the single fallback
 * tier below a project. Every job in every project under an org receives that
 * org's secrets automatically; a project can add its own on top, and on a
 * key-name collision the project's value wins. Decryption happens in-memory
 * only — metadata routes never expose plaintext.
 */
export class OrgSecretRepository {
  constructor(private readonly db: pg.Pool) {}

  async listForOrganization(organizationId: string): Promise<ProjectSecretMetadata[]> {
    const result = await this.db.query<OrgSecretRow>(
      `SELECT id, organization_id, key_name, encrypted_value, created_at, updated_at
       FROM organization_secrets
       WHERE organization_id = $1
       ORDER BY key_name ASC`,
      [organizationId],
    );
    return result.rows.map(mapMetadata);
  }

  async upsert(
    organizationId: string,
    key: string,
    plaintextValue: string,
  ): Promise<ProjectSecretMetadata> {
    const encryptedValue = encrypt(plaintextValue);
    const result = await this.db.query<OrgSecretRow>(
      `INSERT INTO organization_secrets (organization_id, key_name, encrypted_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, key_name)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()
       RETURNING id, organization_id, key_name, encrypted_value, created_at, updated_at`,
      [organizationId, key, encryptedValue],
    );
    return mapMetadata(result.rows[0]);
  }

  async delete(organizationId: string, secretId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM organization_secrets WHERE organization_id = $1 AND id = $2`,
      [organizationId, secretId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Decrypts in-memory. Only internal/security-relevant call sites reach this. */
  async decryptAllForOrganization(organizationId: string): Promise<Record<string, string>> {
    const result = await this.db.query<OrgSecretRow>(
      `SELECT id, organization_id, key_name, encrypted_value, created_at, updated_at
       FROM organization_secrets
       WHERE organization_id = $1`,
      [organizationId],
    );
    const secrets: Record<string, string> = {};
    for (const row of result.rows) {
      secrets[row.key_name] = decrypt(row.encrypted_value);
    }
    return secrets;
  }
}