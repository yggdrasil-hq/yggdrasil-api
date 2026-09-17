-- ADR 018 amendment (issue #5): the feature tier of model-config resolution —
-- the narrowest tier, applied to any job that belongs to a feature. Mirrors the
-- project tier's two mechanisms exactly, one level down:
--
--   1. feature_job_model_overrides — the catalog-selection path, same shape as
--      project_job_model_overrides (027): presence of a row means override,
--      absence means inherit.
--   2. feature_model_secrets — the custom-triplet path, same encrypted-storage
--      shape as project_secrets (005) and organization_secrets (016), scoped to
--      the feature instead of the project. Only the three MODEL_* keys are ever
--      written through it (see model-config/feature-routes.ts) — a feature is
--      not a deployment unit, so it has no general env-var delivery path the
--      way a project does.
--
-- ON DELETE RESTRICT on model_id (matching 026/027) is what keeps ADR 018 item
-- 4's "a model in active use cannot be deleted until unassigned" true at the
-- feature tier too — the FK violation is the enforcement.

CREATE TABLE IF NOT EXISTS feature_job_model_overrides (
  feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  job_kind VARCHAR(32) NOT NULL CHECK (job_kind IN ('spec_grill', 'feature_build', 'test_run', 'agentic_review', 'design_grill')),
  model_id UUID NOT NULL REFERENCES organization_models(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (feature_id, job_kind)
);

CREATE TABLE IF NOT EXISTS feature_model_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  key_name VARCHAR(128) NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (feature_id, key_name)
);

CREATE INDEX IF NOT EXISTS idx_feature_model_secrets_feature_id
  ON feature_model_secrets(feature_id);
