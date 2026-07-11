-- ADR 011 item 6: run_started, synthesized locally by the Orchestrator the
-- moment a job's pod is confirmed up (internal/rpc/curated.go's
-- EventRunStarted in the orchestrator repo), drives the feature's
-- queued -> running transition (FeatureRepository.setRunning).

ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_type_check;

ALTER TABLE job_events ADD CONSTRAINT job_events_type_check
  CHECK (type IN ('agent_text', 'ask_user', 'submit_adr', 'run_failed', 'run_cancelled', 'user_message', 'submit_build_result', 'run_started'));
