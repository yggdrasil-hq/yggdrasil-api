-- ADR 006 item 8: persists the curated events the Orchestrator relays from
-- a running job's Pi RPC session (agent_text/ask_user/submit_adr/
-- run_failed/run_cancelled — see internal/rpc/curated.go in the
-- orchestrator repo). Read-side (a GET endpoint, WebSocket relay to the Web
-- app, notifications) is a tracked follow-up; this migration only adds
-- storage.

CREATE TABLE IF NOT EXISTS job_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type VARCHAR(32) NOT NULL
    CHECK (type IN ('agent_text', 'ask_user', 'submit_adr', 'run_failed', 'run_cancelled')),
  question TEXT,
  markdown TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_id_created_at ON job_events(job_id, created_at);
