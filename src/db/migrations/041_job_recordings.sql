-- ADR 029: per-job screen recordings for test runs.
--
-- Playwright has been installed in the test_run image since ADR 004, and
-- `recordingPath` has flowed agent -> contract tool -> curated event -> this
-- database since ADR 015 -- but a *path* was all it ever was. The path pointed
-- inside the job pod, and the pod is deleted at job end, so every recording
-- ever reported was already a dead pointer. This table is where the bytes
-- actually land.
--
-- Job-keyed (not report-keyed): a recording belongs to one run, and a retried
-- run is a new job row (ADR 012), so each attempt gets its own artifact rather
-- than overwriting the attempt it replaced. Note `script_test_run` has no
-- recording -- it runs no browser -- so rows exist only for `test_run` and
-- `feature_build`, which is enforced in the upload handler, not by a CHECK,
-- since that is a fact about job kinds rather than about this table.
--
-- `data` is NULLABLE, and that is the load-bearing decision here. Retention
-- reclaims the bytes by setting `data = NULL` and stamping `purged_at`, leaving
-- the row in place. Deleting the row instead would erase the fact that a
-- recording was ever captured, and "this run recorded a session whose artifact
-- has since been reclaimed" would become indistinguishable from "this run was
-- never recorded" -- so an expired recording would render as a broken or empty
-- player with no explanation (ADR 029 item 6). A tombstone costs one row and
-- buys an honest UI.
--
-- Note the absence of a `path` column: the agent's own in-pod path is recorded
-- on the report (`recording_path`) as provenance, and is deliberately not
-- duplicated here, because nothing local to the pod is resolvable once the pod
-- is gone. This table is addressed by job id.
CREATE TABLE IF NOT EXISTS job_recordings (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Constrained to the formats a browser <video> can play, so nothing
  -- unplayable can be stored and then look broken at playback time.
  content_type VARCHAR(64) NOT NULL
    CHECK (content_type IN ('video/webm', 'video/mp4')),
  -- The size as received, kept after purge: "how large was it" survives the
  -- bytes, which is what makes a purged artifact explicable in the UI.
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  data BYTEA,
  expires_at TIMESTAMPTZ NOT NULL,
  purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A tombstone is exactly "purged, and no longer holding bytes". Stated as a
  -- constraint so a half-purged row (bytes gone but unstamped, or stamped while
  -- still holding data) cannot be written by a future code path.
  CONSTRAINT job_recordings_purge_consistent
    CHECK ((data IS NULL) = (purged_at IS NOT NULL))
);

-- Project scoping is how every read authorizes (the same join every other
-- project read uses), and run history is newest-first.
CREATE INDEX IF NOT EXISTS idx_job_recordings_project_created
  ON job_recordings(project_id, created_at DESC);

-- The sweeper's own predicate, exactly: rows still holding bytes that are past
-- their expiry. Partial, so the index stays proportional to what is actually
-- reclaimable rather than to the (mostly tombstoned) table.
CREATE INDEX IF NOT EXISTS idx_job_recordings_reclaimable
  ON job_recordings(expires_at)
  WHERE data IS NOT NULL;
