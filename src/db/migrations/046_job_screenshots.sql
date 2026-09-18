-- Issue #22: per-step screenshots for test runs.
--
-- `test_run_steps.screenshot_path` (migration 019) has flowed agent -> contract
-- tool -> curated event -> this database since ADR 015, and it has always been
-- the same dead pointer ADR 029 fixed for recordings: the value is a path
-- *inside the job pod*, and the pod is deleted the moment the run ends (ADR 006
-- item 11). Nothing ever read the bytes, so nothing was ever stored, so
-- `screenshotPath` has been a trap for whoever tries to use it next. This table
-- is where the bytes actually land.
--
-- ## Why a separate table rather than a column on job_recordings
--
-- Four reasons, and the first is the one that decides it:
--
--   1. **Cardinality.** A job has at most one recording and up to one screenshot
--      *per reported step*. Folding N images into the single recording row would
--      mean an array or a JSON blob, and that destroys the per-artifact tombstone
--      ADR 029 item 6 depends on: "this artifact existed and was reclaimed" must
--      stay distinguishable from "it was never captured", and a purged element
--      inside an array cannot say that as cleanly as a row can.
--   2. **Different caps.** A screenshot is a few hundred kB; a recording is tens
--      of MB. One shared `byte_size` cap would be either far too permissive per
--      screenshot or far too strict for video.
--   3. **Different arrival.** A recording is uploaded once, after the session
--      ends; screenshots arrive with each `report_test_step`, interleaved with
--      the event stream. Keying them separately lets each be upserted on its own
--      natural key without contending on one row.
--   4. **Independent retention, shared by default.** Both annotate the same run
--      and are useful for the same window, so the defaults agree (30 days). But
--      screenshots are three orders of magnitude smaller, so a project may
--      reasonably keep them longer than the video — and separate tables make
--      that a config value rather than a migration. That is the "one table or
--      two" question issue #22 asks to settle, answered two, with the defaults
--      agreeing so the operator sees one policy unless they choose otherwise.
--
-- ## What is deliberately the same as job_recordings
--
-- `data` is NULLABLE and `purged_at` is stamped in lockstep with it, so retention
-- tombstones rather than deletes and an expired screenshot can still be
-- explained. That consistency is enforced by a CHECK constraint, not by
-- convention, so a future code path cannot write a half-purged row.
--
-- Addressed by `id`, not by step name. A step name is free text from the test
-- markdown's `##` headings and can contain anything a URL would have to encode;
-- the metadata read carries the name, and the bytes are fetched by a stable id.
-- That mirrors how a recording is addressed by job id rather than by its path.
CREATE TABLE IF NOT EXISTS job_screenshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Matches `test_run_steps.name`, which is TEXT; capped so a pathological
  -- heading cannot be used to stuff the table or break the unique key's index.
  step_name VARCHAR(256) NOT NULL CHECK (length(trim(step_name)) > 0),
  -- Only formats a browser renders safely as an image. **SVG is deliberately
  -- absent**, and that is a security decision rather than an oversight: an SVG
  -- is a document that can carry script, and these bytes are served inline from
  -- our own origin behind a session cookie, so storing one would be stored XSS
  -- against every member of the project. PNG/JPEG/WebP have no such capability.
  content_type VARCHAR(64) NOT NULL
    CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  -- The size as received, kept after purge, so a reclaimed artifact stays
  -- explicable in the UI.
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  data BYTEA,
  expires_at TIMESTAMPTZ NOT NULL,
  purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT job_screenshots_purge_consistent
    CHECK ((data IS NULL) = (purged_at IS NOT NULL)),
  -- One screenshot per step, which is what makes the upload an idempotent upsert
  -- on the same key `test_run_steps` uses (`PRIMARY KEY (job_id, name)`). A
  -- retried post must replace, not duplicate — the Orchestrator's upload is a
  -- best-effort side channel with no exactly-once guarantee.
  CONSTRAINT job_screenshots_one_per_step UNIQUE (job_id, step_name)
);

-- Deliberately *no* foreign key to `test_run_steps(job_id, name)`, even though
-- the key is available. A step row is overwritten by a re-report of the same
-- step, and an artifact must not be destroyed by bookkeeping about it — the same
-- reasoning that makes the deploy ledger's `job_id` `ON DELETE SET NULL` rather
-- than `CASCADE`. The artifact outlives the report that described it.

-- Project scoping is how every read authorizes (the same join every other
-- project read uses), and a run's screenshots are read newest-first.
CREATE INDEX IF NOT EXISTS idx_job_screenshots_project_created
  ON job_screenshots(project_id, created_at DESC);

-- The read path that lists one run's screenshots, in report order.
CREATE INDEX IF NOT EXISTS idx_job_screenshots_job
  ON job_screenshots(job_id, created_at ASC);

-- The sweeper's own predicate, exactly: rows still holding bytes past their
-- expiry. Partial, so the index stays proportional to what is actually
-- reclaimable rather than to the (mostly tombstoned) table.
CREATE INDEX IF NOT EXISTS idx_job_screenshots_reclaimable
  ON job_screenshots(expires_at)
  WHERE data IS NOT NULL;
