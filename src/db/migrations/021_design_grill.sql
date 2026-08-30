-- ADR 014: job-scoped design_grill sessions and live HTML snapshots.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS design_name VARCHAR(128),
  ADD COLUMN IF NOT EXISTS design_slug VARCHAR(96),
  ADD COLUMN IF NOT EXISTS design_description TEXT;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS has_design_surface BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
  'spec_grill', 'feature_build', 'test_run', 'deploy',
  'script_test_run', 'agentic_review', 'design_grill'
));

ALTER TABLE job_events
  ADD COLUMN IF NOT EXISTS design_snapshot JSONB;

ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_type_check;
ALTER TABLE job_events ADD CONSTRAINT job_events_type_check CHECK (type IN (
  'agent_text', 'ask_user', 'submit_adr', 'run_failed', 'run_cancelled',
  'user_message', 'submit_build_result', 'run_started',
  'request_action_item', 'submit_review', 'report_test_step',
  'submit_test_report', 'update_design_preview', 'submit_design'
));

CREATE INDEX IF NOT EXISTS idx_jobs_project_kind_created
  ON jobs(project_id, kind, created_at DESC);
