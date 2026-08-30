-- ADR 016 (Track A4): org-level provider/secret config, retiring ADR 007's
-- per-user default model configuration (items 8-10). Organizations own the
-- model-config triplet and generic secrets; a project inherits its org's
-- config and can override project-secrets on top (project wins on a key-name
-- collision). Same envelope encryption as project_secrets/user_secrets; only
-- ciphertext ever lands here. Per-user user_secrets is retired outright —
-- there is no user fallback tier anymore.

CREATE TABLE IF NOT EXISTS organization_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_name VARCHAR(128) NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, key_name)
);

CREATE INDEX IF NOT EXISTS idx_org_secrets_organization_id
  ON organization_secrets(organization_id);