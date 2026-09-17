-- ADR 026: the test-run scheduler's poll query.
--
-- Every tick asks the same question — "which enabled tests are overdue?" —
-- against the predicate `enabled = TRUE AND (last_run_at IS NULL OR
-- last_run_at < now)`. The partial index below covers exactly that: it holds
-- only enabled rows, ordered by the column the predicate ranges over, so the
-- planner can seek to the overdue ones instead of filtering the whole table.
--
-- Deliberately partial rather than a plain `(enabled, last_run_at)` index:
-- paused tests are never candidates, so indexing them would grow the index with
-- rows no query can ever use. The predicate is written as bare `enabled` (not
-- `enabled = TRUE`) because PostgreSQL only matches a partial index to a query
-- when the expressions are equivalent, and this is the form the planner
-- recognises.
--
-- This is an optimisation, not a correctness requirement: the tick is correct
-- without it, and on a small self-hosted install a sequential scan of `tests`
-- would be fine. It is included because the scheduler queries this table every
-- minute for the life of the deployment, which is exactly the shape that
-- eventually needs the index rather than the shape that merely could.
--
-- `last_run_at` is stamped by the scheduler alone (see
-- `scheduling/repository.ts`); a feature-driven run deliberately does not
-- touch it, which is why it is a stable sort/range key here.
CREATE INDEX IF NOT EXISTS idx_tests_enabled_last_run_at
  ON tests(last_run_at)
  WHERE enabled;
