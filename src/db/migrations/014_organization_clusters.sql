-- ADR 016 (Track A2): per-Organization Kubernetes cluster configuration
-- (ADR 016 items 11-13). Removes the platform-wide default cluster: every
-- Organization must explicitly configure its own cluster before it can
-- create projects (a hard gate, gating `organizations.status`
-- pending_cluster -> ready). The kubeconfig is stored envelope-encrypted at
-- rest exactly like secrets (project_secrets / user_secrets), and only
-- ciphertext ever lands here — decryption happens in-memory in the API
-- process or is handed to the Orchestrator, never persisted in plaintext.

CREATE TABLE IF NOT EXISTS organization_clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  encrypted_kubeconfig TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_clusters_organization_id
  ON organization_clusters(organization_id);