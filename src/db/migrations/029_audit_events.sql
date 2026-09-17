-- ADR 028: audit logging / trails (Phase 4).
--
-- One row per meaningful mutation the API authorized, organization-scoped
-- (ADR 016 item 4 made Organization the tenancy boundary, so it is the only
-- scope an audit trail can be read at). Written by explicit recordAudit()
-- calls at the mutation sites themselves, never by a blanket middleware over
-- all mutating routes -- a generic middleware cannot produce a
-- domain-meaningful action name or target id.
--
-- actor_user_id is nullable because not every mutation has a human behind it:
-- GitHub webhooks and Orchestrator/internal job-driven writes are recorded
-- with actor_kind 'webhook'/'system'/'job' and no user.
--
-- project_id/actor_user_id are ON DELETE SET NULL, not CASCADE: deleting a
-- project (or a user) must not erase the record that it existed and was
-- acted on -- that is the whole point of a trail. metadata is never used to
-- carry secret plaintext (see src/audit/record.ts's contract).
--
-- No retention/pruning policy: kept indefinitely, per ADR 028 item 6.

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind VARCHAR(16) NOT NULL
    CHECK (actor_kind IN ('user', 'system', 'webhook', 'job')),
  action VARCHAR(128) NOT NULL,
  target_type VARCHAR(64),
  target_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The two read shapes ADR 028 item 7 specifies: "this org's trail, newest
-- first" and "this project's trail, newest first".
CREATE INDEX IF NOT EXISTS idx_audit_events_organization_created
  ON audit_events (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_project_created
  ON audit_events (project_id, created_at DESC);
