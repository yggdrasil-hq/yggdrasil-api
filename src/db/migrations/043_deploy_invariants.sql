-- ADR 022 §5/§6, issue #26: make the deploy/rollback path's two ledger
-- invariants database facts rather than things the route and the Orchestrator
-- try to remember.

-- 1. One deployment operation in flight per project.
--
-- POST /:projectId/rollback read the latest deploy/rollback job and then
-- dispatched it — a check-then-act. Two concurrent requests could both pass
-- the check and race the same Helm release; Helm refuses the second operation,
-- which surfaced as a confusing failure rather than as "something is already
-- running". A partial unique index closes the window at the database, where it
-- cannot be raced, instead of narrowing it in the route.
--
-- Dedupe first, so an install that already hit the race (or is carrying a job
-- row stuck in a non-terminal status) can still apply this migration. Only rows
-- that are redundant — a newer in-flight deploy/rollback job exists for the
-- same project — are cancelled, and the reason is written to the row so the
-- change is visible rather than silent. A cancelled job is not in the index's
-- predicate, so it no longer blocks the project.
DO $$
DECLARE
  cancelled INTEGER;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY project_id ORDER BY created_at DESC, id DESC
           ) AS rank
    FROM jobs
    WHERE kind IN ('deploy', 'rollback')
      AND status IN ('pending', 'running')
  )
  UPDATE jobs
  SET status = 'cancelled',
      completed_at = NOW(),
      last_error = 'Cancelled while making "one deployment operation per project" a database constraint (migration 043): a newer deploy/rollback job for this project was already in flight.'
  WHERE id IN (SELECT id FROM ranked WHERE rank > 1);

  GET DIAGNOSTICS cancelled = ROW_COUNT;
  IF cancelled > 0 THEN
    RAISE NOTICE 'migration 043: cancelled % redundant in-flight deploy/rollback job(s)', cancelled;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_one_active_deploy_per_project
  ON jobs(project_id)
  WHERE kind IN ('deploy', 'rollback') AND status IN ('pending', 'running');

-- 2. At most one ledger row per job.
--
-- POST /internal/jobs/:jobId/deploy-result is the single write to
-- project_deploys and it is a fire-and-forget call from the Orchestrator. A
-- lost report silently removes a rollback target: the revision did apply, but
-- nothing recorded it, so the user cannot undo a deploy that is live. The
-- Orchestrator now retries that report (issue #26), which means the API can
-- receive the same outcome more than once — the first attempt lands and its
-- response is lost to an API restart or a network blip, which is exactly the
-- case the retry exists to cover.
--
-- A deploy job reaches exactly one terminal state and reports it once, so one
-- row per job is the correct cardinality, and a unique index on job_id makes
-- the ingest idempotent rather than merely likely to be called once.
--
-- job_id is nullable on purpose (ON DELETE SET NULL): a ledger row outlives the
-- queue row that produced it, and any number of detached rows may coexist — so
-- the index is partial and only covers attached ones.
DO $$
DECLARE
  removed INTEGER;
BEGIN
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY job_id ORDER BY created_at DESC, id DESC
           ) AS rank
    FROM project_deploys
    WHERE job_id IS NOT NULL
  )
  DELETE FROM project_deploys
  WHERE id IN (SELECT id FROM ranked WHERE rank > 1);

  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed > 0 THEN
    RAISE NOTICE 'migration 043: removed % duplicate deploy-ledger row(s) for the same job', removed;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_deploys_job_id
  ON project_deploys(job_id)
  WHERE job_id IS NOT NULL;
