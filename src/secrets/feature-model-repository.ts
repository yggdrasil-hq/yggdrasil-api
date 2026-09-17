import type pg from "pg";
import { decrypt, encrypt } from "./encryption.js";
import type { ProjectSecretMetadata } from "./types.js";

interface FeatureSecretRow {
  id: string;
  feature_id: string;
  key_name: string;
  encrypted_value: string;
  created_at: Date;
  updated_at: Date;
}

function mapMetadata(row: FeatureSecretRow): ProjectSecretMetadata {
  return {
    id: row.id,
    key: row.key_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * ADR 018 amendment (issue #5): a feature's own custom model triplet — the
 * narrowest tier's escape hatch, mirroring SecretRepository (project_secrets)
 * one level down, with the same envelope encryption and the same
 * metadata-only read surface (plaintext never leaves the API process).
 *
 * Only the three MODEL_* keys are ever written through this repository — see
 * model-config/feature-routes.ts, which validates the key against
 * MODEL_CONFIG_KEYS. Unlike project_secrets there is no general env-var story
 * here: a feature is not a deployment unit.
 */
export class FeatureModelSecretRepository {
  constructor(private readonly db: pg.Pool) {}

  /** Metadata only — never plaintext. Safe to expose to feature-facing routes. */
  async listForFeature(featureId: string): Promise<ProjectSecretMetadata[]> {
    const result = await this.db.query<FeatureSecretRow>(
      `SELECT id, feature_id, key_name, encrypted_value, created_at, updated_at
       FROM feature_model_secrets
       WHERE feature_id = $1
       ORDER BY key_name ASC`,
      [featureId],
    );
    return result.rows.map(mapMetadata);
  }

  async upsert(
    featureId: string,
    key: string,
    plaintextValue: string,
  ): Promise<ProjectSecretMetadata> {
    const encryptedValue = encrypt(plaintextValue);
    const result = await this.db.query<FeatureSecretRow>(
      `INSERT INTO feature_model_secrets (feature_id, key_name, encrypted_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (feature_id, key_name)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()
       RETURNING id, feature_id, key_name, encrypted_value, created_at, updated_at`,
      [featureId, key, encryptedValue],
    );
    return mapMetadata(result.rows[0]);
  }

  async delete(featureId: string, secretId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM feature_model_secrets WHERE feature_id = $1 AND id = $2`,
      [featureId, secretId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Decrypts in-memory. Called only by the internal deploy-time endpoint — never exposed to session-authenticated routes. */
  async decryptAllForFeature(featureId: string): Promise<Record<string, string>> {
    const result = await this.db.query<FeatureSecretRow>(
      `SELECT id, feature_id, key_name, encrypted_value, created_at, updated_at
       FROM feature_model_secrets
       WHERE feature_id = $1`,
      [featureId],
    );
    const secrets: Record<string, string> = {};
    for (const row of result.rows) {
      secrets[row.key_name] = decrypt(row.encrypted_value);
    }
    return secrets;
  }
}
