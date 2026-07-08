-- ADR 003 §16: project-level env vars/secrets, envelope-encrypted at rest.
-- Only ciphertext (encrypted_value) ever lands here — decryption happens
-- in-memory in the API process, never persisted.

CREATE TABLE IF NOT EXISTS project_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_name VARCHAR(128) NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, key_name)
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project_id ON project_secrets(project_id);
