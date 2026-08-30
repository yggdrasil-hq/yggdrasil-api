-- ADR 015 item 9: an on-demand test_run can target a feature branch instead
-- of the scheduled runner's default main ref.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ref TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS trigger_source VARCHAR(16);
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_trigger_source_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_trigger_source_check
  CHECK (trigger_source IS NULL OR trigger_source IN ('feature', 'schedule'));

CREATE INDEX IF NOT EXISTS idx_jobs_feature_kind_status
  ON jobs(feature_id, kind, status);

-- Test reports are intentionally canonical JSON-shaped data. Yggdrasil does
-- not parse framework-specific output; the agent submits these values.
CREATE TABLE IF NOT EXISTS test_run_steps (
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status VARCHAR(8) NOT NULL CHECK (status IN ('pass', 'fail')),
  details TEXT,
  screenshot_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_id, name)
);

CREATE TABLE IF NOT EXISTS test_run_reports (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  passed INT NOT NULL CHECK (passed >= 0),
  failed INT NOT NULL CHECK (failed >= 0),
  skipped INT NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  total INT NOT NULL CHECK (total >= 0),
  coverage_percent NUMERIC,
  failing_tests JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT NOT NULL,
  recording_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (total >= passed + failed + skipped)
);
