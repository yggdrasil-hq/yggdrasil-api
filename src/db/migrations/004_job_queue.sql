-- ADR 003: Postgres-backed job queue. Adds claim-tracking columns to the
-- existing jobs table (the queue itself — no separate broker) and the
-- 'deploy' job kind (primary-deployment redeploy on merge to main).

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS locked_by TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_error TEXT;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check
  CHECK (kind IN ('spec_grill', 'feature_build', 'test_run', 'deploy'));

CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at);
