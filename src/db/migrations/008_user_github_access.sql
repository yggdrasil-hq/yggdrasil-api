CREATE TABLE IF NOT EXISTS user_installation_access (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id UUID NOT NULL REFERENCES github_installations(id) ON DELETE CASCADE,
  last_confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, installation_id)
);

CREATE INDEX IF NOT EXISTS idx_user_installation_access_installation
  ON user_installation_access (installation_id);

CREATE TABLE IF NOT EXISTS user_github_sync_state (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
