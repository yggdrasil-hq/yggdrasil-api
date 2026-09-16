-- ADR 018: org-scoped named providers (OpenRouter, Anthropic, custom
-- OpenAI-compatible), replacing the flat MODEL_BASE_URL/MODEL_API_KEY/MODEL_ID
-- triplet as the org-level story. One encrypted API key per provider, same
-- envelope encryption as organization_secrets/project_secrets.

CREATE TABLE IF NOT EXISTS organization_model_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  provider_type VARCHAR(32) NOT NULL CHECK (provider_type IN ('openrouter', 'anthropic', 'custom_openai_compatible')),
  base_url TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, name)
);

CREATE INDEX IF NOT EXISTS idx_org_model_providers_organization_id
  ON organization_model_providers(organization_id);
