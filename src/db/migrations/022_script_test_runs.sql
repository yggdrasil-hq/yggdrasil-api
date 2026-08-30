-- ADR 015 item 10: identify which optional structure-standard script a
-- non-agent Testing job runs. The group is job metadata, not a Test entity:
-- unit/integration scripts have no schedule or user-authored Test record.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS test_group VARCHAR(16);

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_test_group_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_test_group_check
  CHECK (test_group IS NULL OR test_group IN ('unit', 'integration'));

CREATE INDEX IF NOT EXISTS idx_jobs_feature_test_group
  ON jobs(feature_id, kind, test_group, created_at);
