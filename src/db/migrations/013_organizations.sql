-- ADR 016 (Track A1): Organization entity, org-wide memberships and roles,
-- token-based invites (no email), and the adjustable role -> capability
-- matrix adopted from design/settings/organization/members. Purely additive:
-- no cluster-gate enforcement, no project-ownership change, no user_secrets
-- retirement yet — those land in later slices (A2/A3/A4).

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(128) NOT NULL,
  slug VARCHAR(128) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_personal BOOLEAN NOT NULL DEFAULT FALSE,
  -- ADR 016 item 11: pending_cluster -> ready. A1 creates the column and the
  -- status vocabulary; A2 enforces it as a hard gate on project creation.
  status VARCHAR(32) NOT NULL DEFAULT 'pending_cluster'
    CHECK (status IN ('pending_cluster', 'ready')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_organizations_is_personal ON organizations(is_personal);

-- One role per membership, org-wide (not per-project) — ADR 016 item 6.
CREATE TABLE IF NOT EXISTS organization_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL
    CHECK (role IN ('admin', 'developer', 'designer', 'product_manager', 'tester')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_memberships_organization_id
  ON organization_memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_user_id
  ON organization_memberships(user_id);

-- Shareable, token-based invite links (ADR 016 items 5). Yggdrasil never
-- sends an email; whoever opens the link and completes GitHub OAuth (new or
-- existing account) is added to the org with the inviter-chosen role.
CREATE TABLE IF NOT EXISTS organization_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token VARCHAR(64) NOT NULL UNIQUE,
  role VARCHAR(32) NOT NULL
    CHECK (role IN ('admin', 'developer', 'designer', 'product_manager', 'tester')),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_invites_organization_id
  ON organization_invites(organization_id);

-- Adjustable role -> capability seed data (ADR 016 item 7). Grants are data,
-- not hardcoded per-role branches in application logic, so a wrong default
-- can be corrected without a redeploy. `level` is full | partial | none,
-- mirroring the wireframe's yes / view·comment / — vocabulary.
CREATE TABLE IF NOT EXISTS role_capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role VARCHAR(32) NOT NULL,
  capability VARCHAR(64) NOT NULL,
  level VARCHAR(16) NOT NULL CHECK (level IN ('full', 'partial', 'none')),
  UNIQUE (role, capability)
);

INSERT INTO role_capabilities (role, capability, level) VALUES
  ('admin',            'org_settings',    'full'),
  ('developer',        'org_settings',    'none'),
  ('designer',         'org_settings',    'none'),
  ('product_manager',  'org_settings',    'none'),
  ('tester',           'org_settings',    'none'),

  ('admin',            'manage_projects', 'full'),
  ('developer',        'manage_projects', 'full'),
  ('designer',         'manage_projects', 'partial'),
  ('product_manager',  'manage_projects', 'partial'),
  ('tester',           'manage_projects', 'partial'),

  ('admin',            'manage_features', 'full'),
  ('developer',        'manage_features', 'full'),
  ('designer',         'manage_features', 'partial'),
  ('product_manager',  'manage_features', 'full'),
  ('tester',           'manage_features', 'partial'),

  ('admin',            'design_sessions', 'full'),
  ('developer',        'design_sessions', 'partial'),
  ('designer',         'design_sessions', 'full'),
  ('product_manager',  'design_sessions', 'partial'),
  ('tester',           'design_sessions', 'none'),

  ('admin',            'manage_tests',    'full'),
  ('developer',        'manage_tests',    'partial'),
  ('designer',         'manage_tests',    'none'),
  ('product_manager',  'manage_tests',    'partial'),
  ('tester',           'manage_tests',    'full'),

  ('admin',            'pr_review',       'full'),
  ('developer',        'pr_review',       'full'),
  ('designer',         'pr_review',       'partial'),
  ('product_manager',  'pr_review',       'full'),
  ('tester',           'pr_review',       'partial')
ON CONFLICT (role, capability) DO NOTHING;