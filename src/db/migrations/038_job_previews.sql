-- ADR 003 §10/§15/§17: ephemeral preview deployments. §10 gives spec_grill,
-- feature_build and test_run a temporary deployment each, §15 fixes the URL
-- scheme (<project-slug>-<kind>-<id>.preview.<domain>), and §17 caps how many
-- may exist at once. None of it existed in code before this migration; the
-- only trace was a PREVIEW_URL env var handed to a test_run pod pointing at a
-- hostname nothing ever served.
--
-- This table is the API's view of that: enough to enforce the cap at job-claim
-- time, to tell the Orchestrator what needs cleaning up after a crash, and to
-- show a user which of their runs has a live environment. The cluster itself
-- remains the source of truth for what actually exists — the Orchestrator
-- reconciles towards these rows, it does not trust them as fact.
--
-- The host is stored rather than re-derived here on purpose: the Orchestrator
-- computes preview identity (internal/preview), and duplicating that format in
-- TypeScript would be two spellings of one contract waiting to drift.
--
-- UNIQUE(job_id) is what makes registration idempotent — one preview per job,
-- upserted. A retried job is a *new* job row (ADR 012), so its new preview is
-- a new row rather than a reuse of the attempt it replaced.
--
-- Status is deliberately small. 'active' is the only state that occupies a
-- slot in the §17 cap, so the distinction between "torn down cleanly" and
-- "failed to come up" is informational, not a scheduling input.
--
-- ON DELETE CASCADE on both keys: a preview row is meaningless without its
-- project or its job, and the cluster resource it describes is already gone
-- (or is being swept) in those cases. The durable record of who did what
-- lives in audit_events (ADR 028), not here.
CREATE TABLE IF NOT EXISTS job_previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'torn_down', 'failed')),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  torn_down_at TIMESTAMPTZ,
  UNIQUE (job_id)
);

-- The claim's admission clause counts active previews per project on every
-- poll tick, so this index is on the hot path — a partial index would be
-- tighter still, but 'torn_down'/'failed' rows are few and the extra
-- selectivity is not worth an index the planner can only sometimes use.
CREATE INDEX IF NOT EXISTS idx_job_previews_project_status
  ON job_previews(project_id, status);

-- The stale-preview sweep asks "still active, and older than the TTL", which
-- never filters by project. Without this the sweep is a sequential scan every
-- interval.
CREATE INDEX IF NOT EXISTS idx_job_previews_active_created
  ON job_previews(created_at)
  WHERE status = 'active';
