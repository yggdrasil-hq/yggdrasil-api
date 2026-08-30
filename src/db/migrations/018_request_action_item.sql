-- ADR 015 items 7-8, 14-16 (Track B3/B6): two more terminal curated events.
-- `request_action_item` (B3): feature_build's implement skill recognizes
-- mid-build it's blocked on something only a human or another job can
-- provide — structurally distinct from a crash, which stays `failed` (ADR
-- 012). `submit_review` (B6): Agentic Review's internal verdict
-- (`approved` | `changes_requested`) — never a real GitHub PR review, to
-- avoid colliding with ADR 013's human-review webhook.

ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_type_check;

ALTER TABLE job_events ADD CONSTRAINT job_events_type_check
  CHECK (type IN ('agent_text', 'ask_user', 'submit_adr', 'run_failed', 'run_cancelled', 'user_message', 'submit_build_result', 'run_started', 'request_action_item', 'submit_review'));