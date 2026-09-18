-- Issue #59: Agentic Review's verdict was never persisted, so the stage's UI had
-- nothing to read — and no read endpoint could have been written.
--
-- **This is a real defect, not just a missing route.** The verdict *reaches* the
-- API: the Orchestrator posts `submit_review` with a `verdict` field (ADR 015
-- items 14-16), `jobEventSchema` validates it (`z.enum(["approved",
-- "changes_requested"])`), and `syncFeatureState` acts on it immediately to move
-- the feature to `in_review` or `returned`. Then it is dropped:
-- `JobEventRepository.create` neither accepted nor stored it, and the row was
-- written with `status` NULL because the Orchestrator sends no `status` for this
-- event.
--
-- So the feature's *lifecycle* recorded the verdict and the feature's *history*
-- did not. A re-opened review, or a review read after the feature had moved on,
-- had no way back to what the reviewer decided. Issue #59 described this as a
-- missing read endpoint; the read could not have worked without this column.
--
-- **Why a dedicated column rather than an existing one.** `status` is the
-- obvious candidate and is unusable: it is `VARCHAR(16)` (migration 011) and
-- `"changes_requested"` is 17 characters, so the longer of the two verdicts does
-- not fit. Overloading it would also mean the same column held a build result in
-- one row and a review verdict in another, which is the kind of shared meaning
-- that makes a later reader guess.
--
-- **Nullable, with no backfill.** Every `submit_review` row written before this
-- migration has no recorded verdict and none can be recovered — the data was
-- never stored. Those rows stay NULL, and readers must treat NULL as "not
-- recorded" rather than as "not reviewed"; the read endpoint does exactly that.
-- A `CHECK` on the column keeps the two known values authoritative rather than
-- letting a typo through a free-text field.
ALTER TABLE job_events ADD COLUMN IF NOT EXISTS verdict VARCHAR(32);

ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_verdict_check;
ALTER TABLE job_events ADD CONSTRAINT job_events_verdict_check
  CHECK (verdict IS NULL OR verdict IN ('approved', 'changes_requested'));

-- The read endpoint asks for one feature's most recent review, which walks
-- `job_events` back to `jobs` by `feature_id`. The existing index is
-- `(job_id, created_at)`, which serves a per-job read but not this one: a feature
-- that has been reviewed, returned and re-reviewed several times would scan every
-- event of every job it ever had. Partial on `type` because reviews are a small
-- minority of all events, so the index stays small and the query is exactly the
-- rows it wants.
CREATE INDEX IF NOT EXISTS idx_job_events_reviews
  ON job_events(created_at DESC)
  WHERE type = 'submit_review';
