-- ADR 018: org-scoped model catalog, each model belonging to exactly one
-- provider. organization_id is denormalized onto this table (rather than
-- requiring a join through provider) for simpler scoping/queries, mirroring
-- how project_secrets/organization_secrets don't join through owners for reads.

CREATE TABLE IF NOT EXISTS organization_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES organization_model_providers(id) ON DELETE CASCADE,
  display_name VARCHAR(128) NOT NULL,
  model_id VARCHAR(256) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, display_name)
);

CREATE INDEX IF NOT EXISTS idx_org_models_organization_id
  ON organization_models(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_models_provider_id
  ON organization_models(provider_id);
