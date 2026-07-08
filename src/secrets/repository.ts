import type pg from "pg";
import { decrypt, encrypt } from "./encryption.js";
import type { ProjectSecretMetadata } from "./types.js";

interface SecretRow {
  id: string;
  project_id: string;
  key_name: string;
  encrypted_value: string;
  created_at: Date;
  updated_at: Date;
}

function mapMetadata(row: SecretRow): ProjectSecretMetadata {
  return {
    id: row.id,
    key: row.key_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SecretRepository {
  constructor(private readonly db: pg.Pool) {}

  /** Metadata only — never plaintext. Safe to expose to project-owner-facing routes. */
  async listForProject(projectId: string): Promise<ProjectSecretMetadata[]> {
    const result = await this.db.query<SecretRow>(
      `SELECT id, project_id, key_name, encrypted_value, created_at, updated_at
       FROM project_secrets
       WHERE project_id = $1
       ORDER BY key_name ASC`,
      [projectId],
    );
    return result.rows.map(mapMetadata);
  }

  async upsert(
    projectId: string,
    key: string,
    plaintextValue: string,
  ): Promise<ProjectSecretMetadata> {
    const encryptedValue = encrypt(plaintextValue);
    const result = await this.db.query<SecretRow>(
      `INSERT INTO project_secrets (project_id, key_name, encrypted_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, key_name)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()
       RETURNING id, project_id, key_name, encrypted_value, created_at, updated_at`,
      [projectId, key, encryptedValue],
    );
    return mapMetadata(result.rows[0]);
  }

  async delete(projectId: string, secretId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM project_secrets WHERE project_id = $1 AND id = $2`,
      [projectId, secretId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Decrypts in-memory. Called only by the internal deploy-time endpoint — never exposed to session-authenticated routes. */
  async decryptAllForProject(projectId: string): Promise<Record<string, string>> {
    const result = await this.db.query<SecretRow>(
      `SELECT id, project_id, key_name, encrypted_value, created_at, updated_at
       FROM project_secrets
       WHERE project_id = $1`,
      [projectId],
    );
    const secrets: Record<string, string> = {};
    for (const row of result.rows) {
      secrets[row.key_name] = decrypt(row.encrypted_value);
    }
    return secrets;
  }
}
