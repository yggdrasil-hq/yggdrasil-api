-- ADR 027: per-user notification preferences (Phase 4).
--
-- Two shapes, because they answer two different questions:
--
--   notification_preferences  "which kinds do I want, in this organization?"
--   project_notification_mutes "keep this project out of my inbox, whatever it is"
--
-- The first is keyed (user, organization, kind) with a NULLable kind: a row
-- with kind IS NULL is the org-wide "all activity" row (the master toggle),
-- and a row with a concrete kind overrides it for that kind. The second is a
-- plain (user, project) pair — a mute is an absolute "not this project", so it
-- needs no kinds axis and no org column (the project already implies its org).
--
-- Absence means "notify": a user with no rows at all keeps today's behaviour
-- exactly, which is why both tables are consulted only to *suppress*.
--
-- Postgres PRIMARY KEY columns cannot be NULL, so the NULL-kind row cannot use
-- a composite PK. Two partial unique indexes express the real invariant
-- instead — one "all kinds" row per (user, org), and one row per
-- (user, org, kind) — and each is a valid ON CONFLICT target.

CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL = every kind in this organization (the master toggle).
  kind VARCHAR(64),
  enabled BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_preferences_all_kinds
  ON notification_preferences (user_id, organization_id)
  WHERE kind IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_preferences_kind
  ON notification_preferences (user_id, organization_id, kind)
  WHERE kind IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_notification_mutes (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_notification_mutes_user
  ON project_notification_mutes (user_id);
