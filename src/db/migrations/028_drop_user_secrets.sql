-- ADR 018 item 8: finish ADR 016's retirement of ADR 007 -- the writable
-- /settings/secrets route and UserSecretRepository were already deleted from
-- the application; this drops the now-fully-unused table itself. No live
-- deployment exists yet, so no backfill/migration path is needed.

DROP TABLE IF EXISTS user_secrets;
