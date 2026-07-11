-- Adds a user-authored event type so replies submitted via
-- POST /projects/:projectId/features/:featureId/messages can be persisted
-- into job_events (in addition to the existing job_replies write used for
-- the Orchestrator's LISTEN/NOTIFY pickup), making them visible through the
-- same polled GET .../events history the spec_grill panel already reads.

ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_type_check;

ALTER TABLE job_events ADD CONSTRAINT job_events_type_check
  CHECK (type IN ('agent_text', 'ask_user', 'submit_adr', 'run_failed', 'run_cancelled', 'user_message'));
