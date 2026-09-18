-- Issue #30: move binary artifacts out of Postgres and into object storage.
--
-- ADR 029 (recordings) and ADR 025 (extension bundles) both stored bytes in the
-- database, both for the same reason and both with the same recorded regret: no
-- object-storage client existed, so a bounded blob in the database beat adding a
-- runtime dependency for one feature. The intended consequence, written down in
-- both ADRs, was that a database backup had started to contain video, and that
-- time-based retention bounds a recording's *age* but not a project's total
-- bytes. `deploy/` has set S3_* variables for both services since the dev stack
-- was written; nothing read them.
--
-- ## What this migration does, and what it deliberately does not
--
-- It does **not** move a single byte, and nothing here orphans one either. That
-- is the decision worth reading, because the alternative — a migration that
-- copies every artifact and nulls the columns — is the version that looks
-- tidier and fails in the field: it needs the bucket to exist and be reachable
-- at the moment the API boots (so a fresh install with object storage not yet up
-- would fail to migrate its own empty database), it makes the migration
-- irreversibly dependent on a network service, and on a large install it holds
-- a transaction open for as long as it takes to stream every recording out.
--
-- Instead each artifact row records **where its bytes are**, so both storage
-- locations can be correct at once and the move can happen incrementally:
--
--   * `storage_backend = 'postgres'` — the column holds the bytes, as before.
--     Every row that exists at migration time is this case (the ADD COLUMN
--     default backfills them), so **existing artifacts keep working untouched**.
--   * `storage_backend = 'object'` — `object_key` names the object, and the
--     column is NULL.
--
-- New writes follow the deployment's configuration: an install with a bucket
-- configured writes there from its first upload, and an install without one
-- keeps writing to Postgres exactly as it does today (so this is additive and
-- nothing has to be switched on to keep working). `backfillObjects` moves
-- existing rows over on demand — see `storage/backfill.ts` — which is what makes
-- "a database backup contains video" a property an operator can retire at a
-- time of their choosing rather than a moment this migration picks for them.
--
-- ## The constraint, and why it is worth its verbosity
--
-- The old `(data IS NULL) = (purged_at IS NOT NULL)` said "bytes present iff not
-- purged". With a second place for bytes to live that is no longer true, so it
-- is replaced by the three states a row may be in — spelled out rather than
-- simplified, because the whole point is that a row claiming to be object-backed
-- while holding database bytes (or vice versa) is the bug this feature would
-- otherwise ship, and a constraint is the only place that can say so once rather
-- than in every code path.

ALTER TABLE job_recordings
  ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(16) NOT NULL DEFAULT 'postgres',
  -- Nullable on purpose: NULL is "the bytes are in the database", which is the
  -- state every pre-existing row is in.
  ADD COLUMN IF NOT EXISTS object_key TEXT;

ALTER TABLE job_screenshots
  ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(16) NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS object_key TEXT;

-- `content` becomes NULLABLE for the same reason `data` already was: an
-- object-backed row has no content in the database. It was NOT NULL because
-- there was nowhere else for it to be.
ALTER TABLE org_extension_files
  ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(16) NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS object_key TEXT,
  ALTER COLUMN content DROP NOT NULL;

-- The backends this codebase knows. Stated as a constraint rather than left to
-- application code, so a typo'd backend in a future code path fails at the write
-- rather than producing a row that no read path recognises.
ALTER TABLE job_recordings DROP CONSTRAINT IF EXISTS job_recordings_storage_backend_check;
ALTER TABLE job_recordings ADD CONSTRAINT job_recordings_storage_backend_check
  CHECK (storage_backend IN ('postgres', 'object'));
ALTER TABLE job_screenshots DROP CONSTRAINT IF EXISTS job_screenshots_storage_backend_check;
ALTER TABLE job_screenshots ADD CONSTRAINT job_screenshots_storage_backend_check
  CHECK (storage_backend IN ('postgres', 'object'));
ALTER TABLE org_extension_files
  DROP CONSTRAINT IF EXISTS org_extension_files_storage_backend_check;
ALTER TABLE org_extension_files ADD CONSTRAINT org_extension_files_storage_backend_check
  CHECK (storage_backend IN ('postgres', 'object'));

-- The three states, exhaustively. Anything else — bytes in both places, an
-- object key with no object backend, a live object row with no key, a purged row
-- still holding bytes — is unwritable.
ALTER TABLE job_recordings DROP CONSTRAINT IF EXISTS job_recordings_purge_consistent;
ALTER TABLE job_recordings DROP CONSTRAINT IF EXISTS job_recordings_storage_consistent;
ALTER TABLE job_recordings ADD CONSTRAINT job_recordings_storage_consistent CHECK (
  -- 1. Live, bytes in the database.
  (data IS NOT NULL AND object_key IS NULL AND storage_backend = 'postgres' AND purged_at IS NULL)
  -- 2. Live, bytes in object storage.
  OR (data IS NULL AND object_key IS NOT NULL AND storage_backend = 'object' AND purged_at IS NULL)
  -- 3. Purged: no bytes anywhere. An object-backed tombstone **keeps its key**,
  --    which is deliberate — if the object deletion failed, the key is the only
  --    record of what to retry, and discarding it would leak an unreachable
  --    object that no later pass could find. A Postgres tombstone has no key to
  --    keep, because nulling `data` was the whole purge.
  OR (data IS NULL AND purged_at IS NOT NULL
      AND ((storage_backend = 'object' AND object_key IS NOT NULL)
           OR (storage_backend = 'postgres' AND object_key IS NULL)))
);

ALTER TABLE job_screenshots DROP CONSTRAINT IF EXISTS job_screenshots_purge_consistent;
ALTER TABLE job_screenshots DROP CONSTRAINT IF EXISTS job_screenshots_storage_consistent;
ALTER TABLE job_screenshots ADD CONSTRAINT job_screenshots_storage_consistent CHECK (
  (data IS NOT NULL AND object_key IS NULL AND storage_backend = 'postgres' AND purged_at IS NULL)
  OR (data IS NULL AND object_key IS NOT NULL AND storage_backend = 'object' AND purged_at IS NULL)
  OR (data IS NULL AND purged_at IS NOT NULL
      AND ((storage_backend = 'object' AND object_key IS NOT NULL)
           OR (storage_backend = 'postgres' AND object_key IS NULL)))
);

-- Extension files have no retention, so no tombstone state: a row either holds
-- its content or names an object. Deleting an extension deletes its rows
-- (migration 040's cascade), which is unchanged.
ALTER TABLE org_extension_files
  DROP CONSTRAINT IF EXISTS org_extension_files_storage_consistent;
ALTER TABLE org_extension_files ADD CONSTRAINT org_extension_files_storage_consistent CHECK (
  (content IS NOT NULL AND object_key IS NULL AND storage_backend = 'postgres')
  OR (content IS NULL AND object_key IS NOT NULL AND storage_backend = 'object')
);

-- ## The sweeper's indexes have to change, and this is the subtle part
--
-- Both reclaimable indexes were `WHERE data IS NOT NULL`, which was exactly the
-- set of rows holding bytes. After this migration that set is *wrong*: an
-- object-backed row holds its bytes in the bucket with `data` NULL, so the old
-- partial predicate would exclude precisely the rows the sweep now most needs to
-- find. The index is rebuilt on the honest predicate — "this row still has bytes
-- somewhere, and they are past their expiry" — so the sweep stays an index seek
-- rather than becoming a sequential scan of a mostly-tombstoned table, which is
-- the property migration 041/046 introduced it for.
DROP INDEX IF EXISTS idx_job_recordings_reclaimable;
CREATE INDEX IF NOT EXISTS idx_job_recordings_reclaimable
  ON job_recordings(expires_at)
  WHERE data IS NOT NULL OR object_key IS NOT NULL;

DROP INDEX IF EXISTS idx_job_screenshots_reclaimable;
CREATE INDEX IF NOT EXISTS idx_job_screenshots_reclaimable
  ON job_screenshots(expires_at)
  WHERE data IS NOT NULL OR object_key IS NOT NULL;
