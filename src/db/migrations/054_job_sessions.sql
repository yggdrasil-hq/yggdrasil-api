-- ADR 032 item 1: the Pi session file a grill run leaves behind, so that a real
-- "resume from here" can fork the agent's actual session instead of re-rendering
-- the transcript (which is what ADR 024's shipped rewind does, and which item 2 of
-- that ADR is explicit is a reconstruction rather than the agent's state).
--
-- The Orchestrator reads the JSONL out of the job pod before the pod is deleted —
-- the same seam and the same posture `collectRecording` already uses for ADR 029's
-- recordings — and posts it here. This table is where the bytes actually land, and
-- it is the third artifact type through issue #30's storage layer rather than a new
-- mechanism.
--
-- ## Why it is keyed by job, not by feature
--
-- A re-run is a new job (ADR 012), which ADR 024 item 1 also follows, so each
-- attempt's session is its own artifact and the lineage between them is the job
-- chain — not a mutable file a later run would overwrite. The same reasoning
-- migration 041 records for recordings, and it matters more here: a fork branches
-- from one specific run's session, so "the feature's session" would be ambiguous
-- the moment a feature has two grills.
--
-- ## Why `outcome` is a stored column rather than something derivable
--
-- ADR 032 item 5 requires three outcomes to be distinguishable, and **two of them
-- look identical from outside this table**: a pod killed before Pi wrote a session
-- (`not_collected`), and a session that existed but could not be read, was over the
-- cap, or whose upload failed (`unavailable`). Both have no bytes. So the
-- distinction is *not derivable* from the artifact, which is normally the test for
-- whether a column should exist — and the reason it is stored anyway is that only
-- the collector knows which happened. The Orchestrator reports it on **every** call
-- for exactly this reason (`apiclient.PostJobSession`: "a route that is only called
-- on success cannot express the difference"), and dropping it here would lose the
-- one record of a fact the user needs. A caller who cannot tell a retrieval failure
-- from a fact about the run is back to the bug the Orchestrator's `rpc.SessionFile.Asked`
-- was added to fix.
--
-- `disabled` is deliberately **not** a permitted value. Collection switched off is a
-- fact about the installation, not about the run, so the Orchestrator posts nothing
-- at all for it — which is why the read path has a fourth state, `unknown`, for "no
-- row". Storing a `disabled` row per job would be per-run noise saying nothing about
-- any run, and no caller could act on it.
--
-- ## Why there is no entry-id / fork-point table here
--
-- ADR 032 item 2 puts the fork points in `get_fork_messages`, and that is an RPC to
-- a **live** Pi process — which no longer exists once the pod is deleted. Nothing
-- captures those entry ids yet, so there is deliberately no column or child table
-- for them: a column nothing can populate is the "declared, marshalled and
-- discarded" shape this suite has had to fix seven times (most recently by the
-- Orchestrator removing `SessionArtifact.ByteSize` rather than wiring it). The
-- read path therefore reports whether a fork is *possible* and never invents a
-- fork point. See the follow-up on issue #28 for the contract the capture needs.
--
-- ## The four byte states, spelled out
--
-- Migration 047's three states (live-in-Postgres, live-in-object, tombstone) are
-- kept, and a fourth is added: **no bytes at all**, which is the failing-outcome
-- case and is *not* a tombstone — nothing was ever stored, so there is nothing
-- reclaimed and `purged_at` must stay NULL. Spelling them out rather than
-- simplifying is the same choice migration 047 made and for the same reason: the
-- states that are wrong (a `collected` row with no bytes anywhere, a failing
-- outcome carrying an artifact, a half-purged row) are the ones this feature would
-- otherwise ship.
CREATE TABLE IF NOT EXISTS job_sessions (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- ADR 032 item 5's three outcomes, verbatim from the Orchestrator's own
  -- constants so neither side needs a mapping table.
  outcome VARCHAR(32) NOT NULL
    CHECK (outcome IN ('collected', 'not_collected', 'unavailable')),
  -- Pi's own id for the session — what a `switch_session` resumes by. Null when Pi
  -- reported none (a session created with `--no-session`), which is a fact and not
  -- an absence of information; `outcome` is what says whether anyone asked.
  session_id TEXT,
  -- Provenance: which pod-local path was read. Worthless once the pod is gone
  -- (migration 041 makes the same point about recordings), carried for the one case
  -- it is for — a stored session an operator expected to hold something else.
  pod_file_path TEXT,
  -- The size as received. NULL for a failing outcome, because a session that was
  -- never read has no size. Never sent by the Orchestrator: `SessionArtifact`
  -- deliberately dropped `ByteSize` because the bytes *are* the request body, so
  -- this number is the API's own measurement of what it received, which is the
  -- authoritative one (a value sent alongside could disagree with the body).
  byte_size INTEGER,
  data BYTEA,
  object_key TEXT,
  storage_backend VARCHAR(16) NOT NULL DEFAULT 'postgres'
    CHECK (storage_backend IN ('postgres', 'object')),
  -- NULL for a failing outcome: there is nothing to expire.
  expires_at TIMESTAMPTZ,
  purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The four states, exhaustively. Anything else is unwritable.
  CONSTRAINT job_sessions_state_consistent CHECK (
    CASE outcome
      -- 1. `collected`, live, bytes in the database.
      WHEN 'collected' THEN
        (purged_at IS NULL AND byte_size IS NOT NULL
         AND data IS NOT NULL AND object_key IS NULL AND storage_backend = 'postgres')
      -- 2. `collected`, live, bytes in the object store.
        OR (purged_at IS NULL AND byte_size IS NOT NULL
            AND data IS NULL AND object_key IS NOT NULL AND storage_backend = 'object')
      -- 3. `collected`, tombstoned: no bytes anywhere, and the size survives so
      --    "how large was it" outlives the bytes (migration 041's reasoning). An
      --    object-backed tombstone **keeps its key** — if the delete failed, the key
      --    is the only record of what to retry, and discarding it would leak an
      --    object nothing could find again.
        OR (purged_at IS NOT NULL AND byte_size IS NOT NULL
            AND data IS NULL
            AND ((storage_backend = 'object' AND object_key IS NOT NULL)
                 OR (storage_backend = 'postgres' AND object_key IS NULL)))
      -- 4. A failing outcome: no bytes, ever, and nothing to reclaim. `purged_at`
      --    must stay NULL — stamping it would render as "this was reclaimed" for an
      --    artifact that was never stored, which is the same lie the three-state
      --    model exists to prevent.
      ELSE
        (data IS NULL AND object_key IS NULL AND purged_at IS NULL
         AND byte_size IS NULL AND expires_at IS NULL)
    END
  )
);

-- Project scoping is how every read authorizes, and a project's sessions are read
-- newest-first.
CREATE INDEX IF NOT EXISTS idx_job_sessions_project_created
  ON job_sessions(project_id, created_at DESC);

-- The sweeper's own predicate, exactly: rows still holding bytes that are past
-- their expiry, plus the tombstones left over from a failed object delete (their
-- key is still set, and migration 047's index does the same for recordings).
CREATE INDEX IF NOT EXISTS idx_job_sessions_reclaimable
  ON job_sessions(expires_at)
  WHERE data IS NOT NULL OR object_key IS NOT NULL;
