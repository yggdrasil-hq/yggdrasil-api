-- ADR 018: the model an Organization defaults to for a given agent-driven job
-- kind. ON DELETE RESTRICT on model_id -- a model in active use as a default
-- must be explicitly unassigned before it can be deleted (ADR 018 item 4).

CREATE TABLE IF NOT EXISTS organization_job_model_defaults (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_kind VARCHAR(32) NOT NULL CHECK (job_kind IN ('spec_grill', 'feature_build', 'test_run', 'agentic_review', 'design_grill')),
  model_id UUID NOT NULL REFERENCES organization_models(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, job_kind)
);
