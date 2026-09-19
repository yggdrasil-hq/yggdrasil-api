-- ADR 032 items 2 and 3: the entry ids a stored session can be forked from.
--
-- ## Why this table did not exist until now
--
-- Migration 054 deliberately had none, and said so: `get_fork_messages` is an RPC
-- to a **live** Pi process, and ADR 006 deletes the Job at the terminal event (a
-- pod holds a live GitHub token and the model key), so nothing could populate a
-- column or table for these. Adding one then would have been the "declared,
-- marshalled and discarded" shape this suite has had to fix seven times — most
-- recently when the Orchestrator removed its own `SessionArtifact.ByteSize` rather
-- than wire it.
--
-- That capture now exists: the Orchestrator sends `get_fork_messages` on the same
-- terminal turn it already opens for `get_state` and `get_session_stats`, and
-- posts the answer here. So this is the follow-up 054 pointed at rather than the
-- shape it was avoiding — and the distinction is worth stating, because "a column
-- nothing populates" and "a column something now populates" look identical in a
-- schema and are the difference between this being right and being the bug.
--
-- ## Why its own table rather than columns on `job_sessions`
--
-- Three reasons, in order of how much they matter:
--
-- 1. **`job_sessions` has an exhaustive byte-state CHECK** with four states, and it
--    is the guard that stops a `collected` row storing no bytes or a failing
--    outcome carrying an artifact. Adding two columns to that row would mean
--    widening that CASE, and the states that are wrong are exactly the ones it
--    exists to make unwritable (054's own reasoning). A child table leaves that
--    invariant untouched.
-- 2. **The absence of fork points is not the absence of a session.** A run can have
--    a stored session and no fork-point record at all (the capture failed, or the
--    answer never came), which is `unknown` rather than `none`. A nullable column on
--    the session row would make "nobody asked" and "Pi said there are none"
--    indistinguishable at the schema level, which is precisely the collapse ADR 032
--    item 5 forbids — so the outcome needs a column of its own whatever table it
--    lives in.
-- 3. **Nothing reads fork points except by job id.** The session table carries
--    `project_id` because a project's sessions are listed newest-first; no such
--    read exists here, and `project_id` is derivable from the job (which is already
--    resolved through the project before any read). So the column is omitted rather
--    than copied for symmetry.
--
-- ## Why `outcome` is a stored column rather than something derivable
--
-- This is item 5's rule applied to a second question, and it has the same shape as
-- `job_sessions.outcome`: two states that look identical from outside —
-- `captured` with an empty `points` array (Pi answered and this session has no
-- previous user messages to fork from, which is a real fact), and `unavailable`
-- (Pi was never successfully asked, so whether there are any is *unknown*). Only
-- the Orchestrator knew which happened, so it reports it and dropping it here
-- would lose the one record of the difference. `points` alone is not sufficient
-- because `[]` and `NULL` would both have to mean one of them.
--
-- A third state, `unknown`, is not stored: it is what **no row** means, exactly as
-- it is for a session (054's `disabled` reasoning). The read path maps it to its
-- own wording rather than inventing a row.
CREATE TABLE IF NOT EXISTS job_fork_points (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  -- The Orchestrator's own vocabulary, two values verbatim so neither side needs
  -- a mapping table. Deliberately **not** the session table's three: a session is
  -- `collected` or one of two failures, while this question was either answered or
  -- not, and there is no "this run produced no fork points" *outcome* — that is
  -- `captured` with an empty list.
  outcome VARCHAR(32) NOT NULL
    CHECK (outcome IN ('captured', 'unavailable')),
  -- `[{"entryId": "…", "text": "…"}]` — Pi's own entry ids and the user-message
  -- text they belong to (ADR 032 item 2). JSONB rather than a child table because
  -- the list is always read and written whole, never queried into, and its only
  -- consumer renders it in order.
  --
  -- NULL unless `captured`, so an unanswered question cannot be read as "there are
  -- none" by a query that forgot to look at `outcome`.
  points JSONB,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The two states, exhaustively: an answered question has a list (possibly
  -- empty), and an unanswered one has nothing at all. Anything else is unwritable,
  -- which is what keeps `points IS NULL` from ever meaning two things.
  CONSTRAINT job_fork_points_outcome_consistent CHECK (
    (outcome = 'captured' AND points IS NOT NULL)
    OR (outcome = 'unavailable' AND points IS NULL)
  )
);

-- ## Retention
--
-- There is deliberately **no `expires_at` here**, and no index for the sweeper:
-- a fork point is not an artifact with its own window, it is a property of the
-- session artifact and expires when that does. The session sweep deletes this row
-- in the same pass that reclaims the bytes (`JobSessionRepository.purgeExpired`),
-- because a fork point without its session file cannot be acted on and the point's
-- `text` is a copy of conversation the retention window was applied to. Giving it
-- a second clock would be a second thing to keep in agreement, which is the drift
-- `shared/artifacts.ts` exists to prevent.
