-- ADR 022: deployment rollback safety net for the always-on primary
-- deployment. ADR 003 §9 shipped auto-deploy-on-merge with no way back, and
-- recorded nothing about what was deployed, so there was no revision to
-- return to. This adds (a) the rollback job kind and the target it rolls
-- back to, and (b) an append-only per-project deploy ledger.

-- A rollback job pins the Helm revision the operator chose at request time,
-- so a queued rollback keeps its target even if newer deploys land before it
-- is claimed. NULL for every other job kind (and NULL means "malformed" for a
-- rollback, which the Orchestrator rejects rather than guessing).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS target_revision INTEGER;

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
  'spec_grill', 'feature_build', 'test_run', 'deploy',
  'script_test_run', 'agentic_review', 'design_grill', 'rollback'
));

-- One row per deploy/rollback attempt, written by the Orchestrator when the
-- operation reaches a terminal state — an append-only ledger, not a second
-- job-status table. Helm revision numbers are the durable handle: they are
-- what a rollback targets, and unlike the jobs row they are read back from
-- the release itself rather than inferred.
--
-- helm_revision is the revision the operation *produced*, which is not the
-- same as the revision requested: `helm rollback` does not rewind the
-- counter, it replays the target's content as a new revision. So a rollback
-- to revision 3 from revision 9 records helm_revision 9's successor (10) and
-- target_revision 3. It is NULL when the attempt produced no new revision
-- (a failed operation), which is exactly what keeps "which revisions can I
-- roll back to" unambiguous: only rows with a non-NULL helm_revision and a
-- completed status are candidates.
--
-- job_id is ON DELETE SET NULL rather than CASCADE: the ledger is what makes
-- a rollback possible, so it must outlive the queue row that produced it.
CREATE TABLE IF NOT EXISTS project_deploys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('deploy', 'rollback')),
  helm_revision INTEGER,
  target_revision INTEGER,
  status VARCHAR(16) NOT NULL CHECK (status IN ('completed', 'failed')),
  last_error TEXT,
  ref VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_deploys_project_created
  ON project_deploys(project_id, created_at DESC);
