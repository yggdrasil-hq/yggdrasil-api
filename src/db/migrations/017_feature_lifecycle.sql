-- ADR 015 (Track B1): the six-stage feature lifecycle. Three new states
-- (`testing`, `agentic_review`, `returned`), one retired (`changes_requested`
-- -> `returned` with `reason: human_review`), the `feature_action_items`
-- table, `features.parent_feature_id` for blocking subtask features
-- (ADR 015 item 5), and `projects.agentic_review_enabled` (ADR 015 item 12,
-- default on).

-- 1. Widen the features.status allow-list to the six-stage model.
ALTER TABLE features DROP CONSTRAINT IF EXISTS features_status_check;
ALTER TABLE features
  ADD CONSTRAINT features_status_check CHECK (status IN (
    'draft', 'spec_ready', 'queued', 'running', 'testing', 'agentic_review',
    'in_review', 'returned', 'merged', 'failed', 'cancelled'
  ));

-- 2. Migrate existing changes_requested rows to the unified returned state
-- (ADR 015 item 20): reason human_review, no other data change.
ALTER TABLE features
  ADD COLUMN IF NOT EXISTS return_reason VARCHAR(32)
    CHECK (return_reason IN ('test_failure', 'agentic_review', 'human_review'));
ALTER TABLE features
  ADD COLUMN IF NOT EXISTS return_comment TEXT;

UPDATE features
SET status = 'returned',
    return_reason = COALESCE(return_reason, 'human_review')
WHERE status = 'changes_requested';

-- 3. Blocking subtask features (ADR 015 item 5): a feature that is a subtask
-- opened by a parent feature's Action Item.
ALTER TABLE features
  ADD COLUMN IF NOT EXISTS parent_feature_id UUID REFERENCES features(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_features_parent_feature_id ON features(parent_feature_id);

-- 4. Action Items (ADR 015 items 4-6): generated once per spec_grill run at
-- the draft -> spec_ready transition.
CREATE TABLE IF NOT EXISTS feature_action_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  type VARCHAR(32) NOT NULL
    CHECK (type IN ('secret_request', 'design_grill', 'subtask_feature', 'test_request')),
  description TEXT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved')),
  resolved_at TIMESTAMPTZ,
  -- type-specific fields (ADR 015 item 6)
  secret_key VARCHAR(128),
  design_session_id UUID,
  subtask_feature_id UUID REFERENCES features(id) ON DELETE SET NULL,
  draft_test_markdown TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feature_action_items_feature_id
  ON feature_action_items(feature_id);
CREATE INDEX IF NOT EXISTS idx_feature_action_items_status
  ON feature_action_items(status);

-- 5. Per-project Agentic Review toggle (ADR 015 item 12), default on.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS agentic_review_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- 6. Widen the jobs.kind allow-list for the new job kinds so later slices
-- (B4-B6) can slot in without constraint dance. `test_run` stays.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_kind_check CHECK (kind IN (
    'spec_grill', 'feature_build', 'test_run', 'deploy',
    'script_test_run', 'agentic_review'
  ));