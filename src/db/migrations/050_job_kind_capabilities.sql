-- Issue #63: let an installation say which job kinds it can actually run.
--
-- **Why this table exists.** `submit_build_result` dispatches a `script_test_run`
-- probe for `unit` and `integration` on every feature, because the API
-- deliberately never reads the repository — the group's toggle is the *script's
-- presence*, which only the image can check (ADR 015 item 10). The consequence on
-- an install with no `SCRIPT_TEST_RUN_IMAGE` is that both probes are dispatched
-- and neither can run: two wasted job rows per feature, and every feature lands in
-- `errored`/`failed` at Testing because nothing could verify it (#44, #53).
--
-- The API cannot avoid that today because **it has no idea what the install can
-- run** — the images are configured in the Orchestrator's environment, and there
-- is no channel for that fact to reach the API. This table is that channel.
--
-- **Why the shared database rather than an HTTP call.** The API never calls the
-- Orchestrator (there is no ORCHESTRATOR_URL reader anywhere in `src/`), and the
-- queue in Postgres is already the one channel both services use — ADR 003 §18's
-- durable queue is how a job reaches the Orchestrator at all. Adding an HTTP
-- capabilities endpoint would introduce a second, differently-authenticated
-- service-to-service path for one boolean per job kind, and would make the API's
-- dispatch depend on the Orchestrator being *up* rather than merely having
-- reported. A row in the shared database is the same information with neither
-- problem, and it is the option issue #63 lists second ("or a flag on the
-- queue").
--
-- **`reported_at` is load-bearing, not bookkeeping.** A row is a claim about a
-- *running* installation, and installations change (an operator adds the image,
-- or the Orchestrator is replaced by a differently-configured one). A stale row
-- must therefore decay back to "unknown" rather than being trusted forever, so
-- readers ignore rows older than a bounded window and treat "unknown" as
-- **capable** — the pre-#63 behaviour. That default is what makes this migration
-- safe to apply on its own: with no rows at all, nothing about dispatch changes.
CREATE TABLE IF NOT EXISTS job_kind_capabilities (
  job_kind VARCHAR(32) PRIMARY KEY,
  -- False once a worker has reported that it has no image for this kind. The
  -- column is named for the fact rather than the absence so a reader does not
  -- have to invert a negative in its head.
  runnable BOOLEAN NOT NULL,
  -- When a worker last asserted this. Deliberately not `created_at`/`updated_at`:
  -- the question a reader asks is "how old is this claim", and a row that is only
  -- ever overwritten has no creation date that stays meaningful.
  reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
