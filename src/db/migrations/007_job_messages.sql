-- ADR 006 items 9-10: queues a human's reply to a running spec_grill job's
-- ask_user question. job_events (006) already records the assistant side
-- of the conversation (the ask_user question itself); this table is the
-- reply direction only, delivered to the Orchestrator via LISTEN/NOTIFY on
-- 'job_replies' rather than polling.

CREATE TABLE IF NOT EXISTS job_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_job_messages_job_id_pending
  ON job_messages(job_id, created_at) WHERE delivered_at IS NULL;
