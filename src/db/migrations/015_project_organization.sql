-- ADR 016 (Track A3): project ownership moves from owner_user_id to
-- organization_id (ADR 016 item 4). A project belongs to exactly one
-- Organization; authorization and listing become org-scoped through
-- organization_memberships, and the five roles' capability matrix governs
-- project-level actions. owner_user_id is retained purely as the creator's
-- reference (a project's original creator), not as an ownership key.

-- Add the column nullable first so existing rows can be backfilled, then
-- enforce NOT NULL — the application has no live deployment, so this is a
-- one-shot data move, not a rolling migration.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

-- Backfill: projects created before the org model route to their creator's
-- personal org (ADR 016 item 2 default routing). For the rare case where a
-- creator has no personal org yet, fall back to any org they're a member of.
UPDATE projects p
SET organization_id = COALESCE(
  (SELECT o.id FROM organizations o
     JOIN organization_memberships m ON m.organization_id = o.id
    WHERE m.user_id = p.owner_user_id AND o.is_personal = TRUE
    LIMIT 1),
  (SELECT o.id FROM organizations o
     JOIN organization_memberships m ON m.organization_id = o.id
    WHERE m.user_id = p.owner_user_id
    ORDER BY o.created_at ASC
    LIMIT 1)
)
WHERE p.organization_id IS NULL;

ALTER TABLE projects
  ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_organization_id ON projects(organization_id);
DROP INDEX IF EXISTS idx_projects_owner_user_id;

-- Project slugs become unique per-organization (mirroring the old
-- UNIQUE (owner_user_id, slug) scope), not globally.
ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_owner_user_id_slug_key;
ALTER TABLE projects
  ADD CONSTRAINT projects_organization_id_slug_key UNIQUE (organization_id, slug);