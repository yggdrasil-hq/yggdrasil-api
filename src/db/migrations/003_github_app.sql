CREATE TABLE IF NOT EXISTS github_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_installation_id BIGINT NOT NULL UNIQUE,
  account_type VARCHAR(32) NOT NULL
    CHECK (account_type IN ('Organization', 'User')),
  account_login VARCHAR(255) NOT NULL,
  account_id BIGINT NOT NULL,
  installed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_github_installations_account
  ON github_installations (account_login);

CREATE TABLE IF NOT EXISTS github_installation_repos (
  installation_id UUID NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  repo_full_name VARCHAR(512) NOT NULL,
  github_repo_id BIGINT NOT NULL,
  PRIMARY KEY (installation_id, repo_full_name)
);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS installation_id UUID REFERENCES github_installations(id),
  ADD COLUMN IF NOT EXISTS github_access_warning BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_projects_installation_id ON projects(installation_id);

CREATE TABLE IF NOT EXISTS install_states (
  state VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_name VARCHAR(128) NOT NULL,
  draft_description TEXT NOT NULL DEFAULT '',
  return_to TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_install_states_expires_at ON install_states(expires_at);
