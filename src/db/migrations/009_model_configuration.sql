-- ADR 007: per-user default model configuration + a project-level warning
-- flag mirroring github_access_warning (ADR 005), set when a dispatch site
-- can't resolve a model configuration for the project.

CREATE TABLE IF NOT EXISTS user_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_name VARCHAR(128) NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, key_name)
);

CREATE INDEX IF NOT EXISTS idx_user_secrets_user_id ON user_secrets(user_id);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS model_config_warning BOOLEAN NOT NULL DEFAULT FALSE;
