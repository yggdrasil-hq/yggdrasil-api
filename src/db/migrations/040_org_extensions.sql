-- ADR 025: uploaded Pi extensions.
--
-- Organization-scoped, like every other org-level config surface (ADR 016
-- item 4 made Organization the tenancy boundary). An upload is a bundle of
-- SOURCE FILES, not an archive: the unit of storage is one row per file, so
-- the API can validate every path it will ever write to disk before it
-- stores anything (see src/extensions/bundle.ts -- that module is where a
-- path-traversal bug would otherwise hide).
--
-- Why Postgres rather than object storage: the API has no object-storage
-- client at all (@aws-sdk/* and minio are absent from package.json and from
-- node_modules; config.ts never reads the S3_* vars that deploy/ sets), so
-- object storage would mean adding a runtime dependency. A bounded set of
-- small source files is well inside what a table handles, and it buys
-- transactional upload (rows + activation in one commit) plus the existing
-- backup/restore story. The repository in src/extensions/repository.ts is
-- the seam if this ever needs to move.
--
-- source_sha256 pins the exact revision that ran: it is computed by the API
-- over the file set and logged by the job container, so "which revision was
-- in that run" is answerable later. It is also recomputed at delivery time
-- and compared, so a partially-written bundle cannot be served.
--
-- uploaded_by_user_id is ON DELETE SET NULL for the same reason ADR 028's
-- audit actor is: "who installed code that runs with our credentials" must
-- survive the uploader's account being deleted.

CREATE TABLE IF NOT EXISTS org_extensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Addressable handle, derived from the display name (src/shared/slug.ts).
  slug VARCHAR(96) NOT NULL,
  name VARCHAR(128) NOT NULL,
  -- Which file inside the bundle Pi is pointed at. Always one of the stored
  -- paths; validated on write so the container never has to guess.
  entry_path VARCHAR(256) NOT NULL,
  source_sha256 CHAR(64) NOT NULL,
  -- Kill switch (ADR 025 item 9): an admin can stop every opted-in project
  -- from loading this without destroying the artifact, which matters during
  -- an incident when the fastest safe action is "turn it off".
  active BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_org_extensions_organization
  ON org_extensions (organization_id, name);

-- content is TEXT: Pi extensions are source modules. A package.json is
-- allowed so an extension can describe itself, but it is rejected on upload
-- if it declares dependencies -- nothing installs them (ADR 025 item 4).
CREATE TABLE IF NOT EXISTS org_extension_files (
  extension_id UUID NOT NULL REFERENCES org_extensions(id) ON DELETE CASCADE,
  path VARCHAR(256) NOT NULL,
  content TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (extension_id, path)
);

-- Per-project opt-in (ADR 025 item 7). Default FALSE: enabling something that
-- runs arbitrary code inside a container holding the project's GitHub
-- installation token must be a deliberate act, never a default. Mirrors
-- projects.agentic_review_enabled's shape (ADR 015 item 12) rather than
-- inventing a settings blob.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS uploaded_extensions_enabled BOOLEAN NOT NULL DEFAULT FALSE;
