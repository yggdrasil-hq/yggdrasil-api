-- ADR 020: designs become a persisted index row.
--
-- The artifact itself does NOT move into Postgres — it stays committed in the
-- managed repo under the project's `designs/<slug>/` directory (ADR 014). This
-- table is metadata pointing at that artifact: identity, lifecycle, and the
-- draft PR that carries it. Duplicating HTML into the database would create a
-- second source of truth plus a sync problem, for no query the repo can't
-- answer.
--
-- The natural key is (project_id, slug), because the slug IS the artifact's
-- identity on disk: `designs/<slug>/` is one folder per design, and
-- (project_id, slug) is therefore already unique in reality. Re-opening a
-- design is the same slug again, which resolves to the same row rather than a
-- duplicate — that is what makes "continue this design" and "start a new one"
-- the same code path.
CREATE TABLE IF NOT EXISTS designs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(128) NOT NULL,
  slug VARCHAR(96) NOT NULL,
  -- 'in_progress': a session exists that has not submitted a final design.
  -- 'finalized': some session called submit_design, committing the folder and
  -- opening its draft PR. Terminal: a later session does not un-finalize a
  -- design that was already committed — run outcome for the newest session is
  -- read from its job row, not mirrored here (ADR 020 item 3).
  status VARCHAR(32) NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'finalized')),
  -- The session that first created this design. Kept for provenance; a design
  -- outlives any single session, so it is not the identity.
  origin_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
  pr_url TEXT,
  finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, slug)
);

-- Browse/history reads a project's designs newest-first (ADR 020 item 6).
CREATE INDEX IF NOT EXISTS idx_designs_project_updated
  ON designs(project_id, updated_at DESC);

-- Which design a design_grill session belongs to, so a design's session history
-- is one indexed lookup instead of a slug join, and so session-scoped routes
-- (cancel) can resolve the design they act on. Nullable: every other job kind
-- has no design.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS design_id UUID REFERENCES designs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_design_created
  ON jobs(design_id, created_at DESC);

-- Backfill from job history (ADR 020 item 7). Every design that exists today
-- got there through a design_grill session — that is the only supported way to
-- produce one (ADR 014) — and every session already carries its design's
-- name/slug/description on the job row. So no GitHub access is needed to seed
-- the index: the data is already here. Without this, every pre-existing
-- project's browse view would come up empty, which is the failure mode ADR 020
-- item 7 exists to prevent.
--
-- One row per (project_id, slug): the EARLIEST session is the origin, and a
-- design counts as finalized if ANY of its sessions submitted.
INSERT INTO designs (
  project_id, name, slug, status, origin_job_id, pr_url, finalized_at,
  created_at, updated_at
)
SELECT
  origin.project_id,
  origin.design_name,
  origin.design_slug,
  CASE WHEN submitted.finalized_at IS NULL THEN 'in_progress' ELSE 'finalized' END,
  origin.id,
  submitted.pr_url,
  submitted.finalized_at,
  origin.created_at,
  COALESCE(submitted.finalized_at, origin.created_at)
FROM (
  SELECT DISTINCT ON (project_id, design_slug)
    id, project_id, design_name, design_slug, created_at
  FROM jobs
  WHERE kind = 'design_grill'
    AND design_slug IS NOT NULL
    AND design_name IS NOT NULL
  ORDER BY project_id, design_slug, created_at ASC
) AS origin
LEFT JOIN (
  SELECT
    j.project_id,
    j.design_slug,
    MIN(e.created_at) AS finalized_at,
    (ARRAY_AGG(e.pr_url ORDER BY e.created_at DESC))[1] AS pr_url
  FROM job_events e
  JOIN jobs j ON j.id = e.job_id
  WHERE e.type = 'submit_design'
    AND j.kind = 'design_grill'
    AND j.design_slug IS NOT NULL
  GROUP BY j.project_id, j.design_slug
) AS submitted
  ON submitted.project_id = origin.project_id
 AND submitted.design_slug = origin.design_slug
ON CONFLICT (project_id, slug) DO NOTHING;

-- Point already-recorded sessions at their design, so history lists are
-- complete for pre-existing designs too.
UPDATE jobs
SET design_id = designs.id
FROM designs
WHERE jobs.kind = 'design_grill'
  AND jobs.design_id IS NULL
  AND jobs.design_slug = designs.slug
  AND jobs.project_id = designs.project_id;
