CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  slug VARCHAR(128) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status VARCHAR(32) NOT NULL DEFAULT 'initializing'
    CHECK (status IN ('initializing', 'ready')),
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_user_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_projects_owner_user_id ON projects(owner_user_id);

CREATE TABLE IF NOT EXISTS project_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  github_owner VARCHAR(255) NOT NULL,
  github_repo VARCHAR(255) NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE (project_id, github_owner, github_repo)
);

CREATE INDEX IF NOT EXISTS idx_project_repositories_project_id
  ON project_repositories(project_id);

CREATE TABLE IF NOT EXISTS features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title VARCHAR(256) NOT NULL,
  slug VARCHAR(128) NOT NULL,
  feature_type VARCHAR(32) NOT NULL DEFAULT 'normal'
    CHECK (feature_type IN ('normal', 'project_init')),
  status VARCHAR(32) NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft', 'spec_ready', 'queued', 'running', 'in_review',
      'changes_requested', 'merged', 'failed', 'cancelled'
    )),
  adr_markdown TEXT,
  awaiting_user_input BOOLEAN NOT NULL DEFAULT FALSE,
  adr_approved BOOLEAN NOT NULL DEFAULT FALSE,
  branch_name VARCHAR(512),
  pr_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_features_project_id ON features(project_id);
CREATE INDEX IF NOT EXISTS idx_features_status ON features(status);

CREATE TABLE IF NOT EXISTS tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(256) NOT NULL,
  spec_markdown TEXT NOT NULL,
  schedule_cron VARCHAR(128) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tests_project_id ON tests(project_id);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind VARCHAR(32) NOT NULL
    CHECK (kind IN ('spec_grill', 'feature_build', 'test_run')),
  feature_id UUID REFERENCES features(id) ON DELETE SET NULL,
  test_id UUID REFERENCES tests(id) ON DELETE SET NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_project_id ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_feature_id ON jobs(feature_id);
CREATE INDEX IF NOT EXISTS idx_jobs_test_id ON jobs(test_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  kind VARCHAR(64) NOT NULL,
  title VARCHAR(512) NOT NULL,
  body TEXT,
  link_path TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id_created
  ON notifications(user_id, created_at DESC);
