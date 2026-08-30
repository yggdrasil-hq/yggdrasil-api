import type pg from "pg";
import { decrypt, encrypt } from "../secrets/encryption.js";

interface ClusterRow {
  id: string;
  organization_id: string;
  encrypted_kubeconfig: string;
  created_at: Date;
  updated_at: Date;
}

export interface OrganizationCluster {
  id: string;
  organizationId: string;
  kubeconfig: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Metadata-only shape safe to expose to session routes — never the plaintext kubeconfig. */
export interface OrganizationClusterMetadata {
  id: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

function mapCluster(row: ClusterRow): OrganizationCluster {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kubeconfig: decrypt(row.encrypted_kubeconfig),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * ADR 016 item 11-13: an Organization's target Kubernetes cluster, stored as
 * an envelope-encrypted kubeconfig (the same encryption as project_secrets).
 * Setting a cluster transitions the Organization's status pending_cluster ->
 * ready, which is what the hard project-creation gate keys off.
 */
export class OrganizationClusterRepository {
  constructor(private readonly db: pg.Pool) {}

  async findMetadata(organizationId: string): Promise<OrganizationClusterMetadata | null> {
    const result = await this.db.query<ClusterRow>(
      `SELECT id, organization_id, encrypted_kubeconfig, created_at, updated_at
       FROM organization_clusters
       WHERE organization_id = $1`,
      [organizationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      organizationId: row.organization_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  /**
   * Decrypts the org's kubeconfig in-memory. Never exposed to session
   * routes; this is the raw material the Orchestrator needs to build a
   * per-org Kubernetes client.
   */
  async decryptKubeconfig(organizationId: string): Promise<string | null> {
    const result = await this.db.query<{ encrypted_kubeconfig: string }>(
      `SELECT encrypted_kubeconfig FROM organization_clusters WHERE organization_id = $1`,
      [organizationId],
    );
    const row = result.rows[0];
    return row ? decrypt(row.encrypted_kubeconfig) : null;
  }

  /** Upserts the org's cluster kubeconfig (envelope-encrypted). */
  async upsert(organizationId: string, kubeconfig: string): Promise<OrganizationClusterMetadata> {
    const encryptedValue = encrypt(kubeconfig);
    const result = await this.db.query<ClusterRow>(
      `INSERT INTO organization_clusters (organization_id, encrypted_kubeconfig)
       VALUES ($1, $2)
       ON CONFLICT (organization_id)
       DO UPDATE SET encrypted_kubeconfig = EXCLUDED.encrypted_kubeconfig, updated_at = NOW()
       RETURNING id, organization_id, encrypted_kubeconfig, created_at, updated_at`,
      [organizationId, encryptedValue],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      organizationId: row.organization_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  async delete(organizationId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM organization_clusters WHERE organization_id = $1`,
      [organizationId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}