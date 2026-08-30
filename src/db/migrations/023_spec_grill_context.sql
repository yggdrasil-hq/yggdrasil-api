-- ADR 015 items 5 and 8: retain the context needed by a follow-up
-- spec_grill run and the finalized design snapshot that satisfied a
-- design_grill Action Item.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS spec_context JSONB;

ALTER TABLE job_events
  ADD COLUMN IF NOT EXISTS action_items JSONB;

ALTER TABLE feature_action_items
  ADD COLUMN IF NOT EXISTS design_snapshot JSONB;
