-- Issue #27 / ADR 021 follow-up 1: a build that resolved merge conflicts with
-- its base is invisible to the reviewer.
--
-- `feature_build` syncs the feature branch onto the latest base before the agent
-- starts and resolves conflicts itself (ADR 021), but nothing in the product said
-- so: the build-progress panel did not show it, and a reviewer opening the PR saw
-- the resolution interleaved with ordinary work with no signal at all. That is the
-- highest-risk part of a build's diff — it is where the agent guessed at how two
-- changes should coexist — so the event vocabulary needs a type for it.
--
-- Widens the constraint rather than replacing the table, the same way 012/018/020/
-- 021 each did for their own new type. Every previously-valid row stays valid: this
-- only adds to the allowed list, which is what makes it safe to apply to a database
-- that is mid-run.
ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_type_check;
ALTER TABLE job_events ADD CONSTRAINT job_events_type_check CHECK (type IN (
  'agent_text', 'ask_user', 'submit_adr', 'run_failed', 'run_cancelled',
  'user_message', 'submit_build_result', 'run_started',
  'request_action_item', 'submit_review', 'report_test_step',
  'submit_test_report', 'update_design_preview', 'submit_design',
  'merge_conflicts'
));
