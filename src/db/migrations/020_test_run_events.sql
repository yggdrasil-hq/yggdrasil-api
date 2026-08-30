-- ADR 015 item 9: test_run progress and final report events are part of the
-- same curated event stream as the other Pi-driven jobs.
ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_type_check;

ALTER TABLE job_events ADD CONSTRAINT job_events_type_check
  CHECK (type IN (
    'agent_text', 'ask_user', 'submit_adr', 'run_failed', 'run_cancelled',
    'user_message', 'submit_build_result', 'run_started',
    'request_action_item', 'submit_review', 'report_test_step',
    'submit_test_report'
  ));
