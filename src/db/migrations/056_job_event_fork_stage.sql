-- ADR 032 item 3: the stage a `fork_failed` event stopped at.
--
-- ## Why this is a column and not prose in `message`
--
-- A fork can stop in three places, and each one asks a different thing of the
-- person looking at it:
--
--   write  — the stored session never reached the pod's filesystem
--   switch — it arrived, and Pi loaded nothing from it
--   fork   — the session loaded fine and the chosen resume point was rejected
--
-- Those are three different diagnoses with three different follow-ups: a delivery
-- fault, an unusable artifact, and a *stale fork point* (the session was collected,
-- the point was offered, and the branch has since gone — a compaction, or a point
-- from a run that was superseded). Recording them only as differently-worded
-- sentences would make them indistinguishable to anything but a careful reader,
-- which is the same collapse ADR 032 item 5 forbids for `unavailable` versus
-- `not_collected` — applied to the dispatch side of the same feature.
--
-- ## Why a CHECK rather than a nullable varchar alone
--
-- The set is closed and the values are meaningful, so a typo should be unwritable
-- rather than merely wrong. This mirrors `job_events_verdict_check` (migration 051)
-- exactly: the constraint is what keeps the column an enum in the database rather
-- than an enum by convention. The `OR fork_stage IS NULL` half is what lets every
-- other event type leave it empty — no other event has a fork stage, and the
-- constraint is scoped to the type rather than to the value so that a future event
-- carrying a stage of its own cannot silently borrow this one.
--
-- ## Why the type CHECK is altered rather than the column added to it
--
-- `job_events.type` already carries a CHECK listing every event type (see the
-- constraint from the original schema plus 051/052/053's neighbours). Adding
-- `fork_failed` means altering that constraint, because a CHECK that does not list
-- the new type makes the insert fail at the database after the API's own schema has
-- accepted it — a 500 for the Orchestrator instead of a recorded event, which is the
-- worst of both: the run fails and nothing says why.
ALTER TABLE job_events
  DROP CONSTRAINT IF EXISTS job_events_type_check;

ALTER TABLE job_events
  ADD CONSTRAINT job_events_type_check CHECK (
    type IN (
      'agent_text', 'ask_user', 'submit_adr', 'run_failed', 'run_cancelled',
      'user_message', 'submit_build_result', 'run_started', 'request_action_item',
      'submit_review', 'report_test_step', 'submit_test_report',
      'update_design_preview', 'submit_design', 'merge_conflicts', 'fork_failed'
    )
  );

ALTER TABLE job_events
  ADD COLUMN IF NOT EXISTS fork_stage VARCHAR(16);

ALTER TABLE job_events
  ADD CONSTRAINT job_events_fork_stage_check CHECK (
    fork_stage IS NULL
    OR (type = 'fork_failed' AND fork_stage IN ('write', 'switch', 'fork'))
  );
