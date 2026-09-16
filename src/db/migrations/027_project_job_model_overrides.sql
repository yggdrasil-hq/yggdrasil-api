-- ADR 018: a project's override of its org's per-job-kind default model,
-- pointing at a model in the org's own catalog. Presence of a row means
-- override; absence means inherit the org default. A project may instead (or
-- additionally, per job kind) supply its own fully custom MODEL_BASE_URL/
-- MODEL_API_KEY/MODEL_ID triplet directly in project_secrets -- that path is
-- unchanged by this migration and takes precedence over this table (ADR 018
-- item 6).

CREATE TABLE IF NOT EXISTS project_job_model_overrides (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_kind VARCHAR(32) NOT NULL CHECK (job_kind IN ('spec_grill', 'feature_build', 'test_run', 'agentic_review', 'design_grill')),
  model_id UUID NOT NULL REFERENCES organization_models(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, job_kind)
);
