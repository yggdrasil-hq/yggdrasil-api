-- ADR 010 items 7-8: feature_build's terminating event, submit_build_result
-- (see internal/rpc/curated.go's EventSubmitBuildResult in the orchestrator
-- repo), carries fields spec_grill's events never needed — a status
-- ("success"/"failure"), a PR URL on success, and a summary either way.

ALTER TABLE job_events ADD COLUMN IF NOT EXISTS status VARCHAR(16);
ALTER TABLE job_events ADD COLUMN IF NOT EXISTS pr_url TEXT;
ALTER TABLE job_events ADD COLUMN IF NOT EXISTS summary TEXT;

ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_type_check;

ALTER TABLE job_events ADD CONSTRAINT job_events_type_check
  CHECK (type IN ('agent_text', 'ask_user', 'submit_adr', 'run_failed', 'run_cancelled', 'user_message', 'submit_build_result'));
