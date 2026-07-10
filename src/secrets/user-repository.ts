import type pg from "pg";
import { decrypt, encrypt } from "./encryption.js";
import type { ProjectSecretMetadata } from "./types.js";

interface SecretRow {
  id: string;
  user_id: string;
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

/** Per-user default secrets (ADR 007) — same shape and encryption as project_secrets. */
export class UserSecretRepository {
  constructor(private readonly db: pg.Pool) {}

  /** Metadata only — never plaintext. Safe to expose to session-authenticated routes. */
  async listForUser(userId: string): Promise<ProjectSecretMetadata[]> {
    const result = await this.db.query<SecretRow>(
      `SELECT id, user_id, key_name, encrypted_value, created_at, updated_at
       FROM user_secrets
       WHERE user_id = $1
       ORDER BY key_name ASC`,
      [userId],
    );
    return result.rows.map(mapMetadata);
  }

  async upsert(
    userId: string,
    key: string,
    plaintextValue: string,
  ): Promise<ProjectSecretMetadata> {
    const encryptedValue = encrypt(plaintextValue);
    const result = await this.db.query<SecretRow>(
      `INSERT INTO user_secrets (user_id, key_name, encrypted_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key_name)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()
       RETURNING id, user_id, key_name, encrypted_value, created_at, updated_at`,
      [userId, key, encryptedValue],
    );
    return mapMetadata(result.rows[0]);
  }

  async delete(userId: string, secretId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM user_secrets WHERE user_id = $1 AND id = $2`,
      [userId, secretId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Decrypts in-memory. Called only by model-config resolution and the internal deploy-time endpoint. */
  async decryptAllForUser(userId: string): Promise<Record<string, string>> {
    const result = await this.db.query<SecretRow>(
      `SELECT id, user_id, key_name, encrypted_value, created_at, updated_at
       FROM user_secrets
       WHERE user_id = $1`,
      [userId],
    );
    const secrets: Record<string, string> = {};
    for (const row of result.rows) {
      secrets[row.key_name] = decrypt(row.encrypted_value);
    }
    return secrets;
  }
}
