-- Issue #73: Agentic Review's findings need a structure the producer can fill.
--
-- `submit_review` carried exactly `{verdict, comment}`, so the skill wrote its
-- findings as *prose* and both shapes that exist for them were permanently empty:
-- the read endpoint's `comments: []` (#59) and the Web app's `findings` array.
-- The consequence is not cosmetic — the UI's blocking-count element counted
-- `findings.filter(blocking)`, so it reported "no blocking issues" over a
-- `changes_requested` review whose comment listed three.
--
-- **Why a jsonb column rather than scalars.** `action_items` and
-- `design_snapshot` are the precedent on this table, and this is the same kind of
-- thing: a variable-length list of small objects. `verdict` went the other way as
-- a scalar, correctly, because it is one value with a CHECK-able domain. The two
-- decisions differ because the payloads differ — the same reasoning migration 052
-- records for `question_form`.
--
-- **Why not reuse `action_items` or `design_snapshot`.** Both are typed and
-- consumed by other features; a third meaning in either would make every reader
-- branch on the event type before it could trust the field.
--
-- **NULL means "findings were written as prose", not "no findings".** That is the
-- state of every `submit_review` row written before this migration, and it is also
-- what a prose-only review writes today — the two are genuinely the same thing to
-- a renderer, so they share a representation rather than one becoming `[]` and
-- needing a separate "was it structured?" test. This is the distinction the Web
-- app's `reviewDetail` already draws between `prose` and `structured`, and the
-- empty-array-vs-null choice is what makes it answerable.
--
-- An **empty array** therefore means "structured, and the reviewer recorded no
-- findings" — which is only reachable from a producer that sent an empty list, and
-- is the one case where a blocking count of 0 is a true statement.
ALTER TABLE job_events ADD COLUMN IF NOT EXISTS review_findings JSONB;

-- The list is only meaningful on `submit_review`, and a shape check keeps a
-- malformed payload from becoming a renderer's problem. Written as a constraint
-- rather than validated only in the route so a row inserted by any future path
-- (a backfill, a manual repair) is held to the same shape.
--
-- Deliberately permissive about the *fields*: `path` and `line` are optional
-- because a finding about the change as a whole is legitimate and different from a
-- missing finding, which is why the read contract already types them nullable.
ALTER TABLE job_events DROP CONSTRAINT IF EXISTS job_events_review_findings_check;
ALTER TABLE job_events ADD CONSTRAINT job_events_review_findings_check CHECK (
  review_findings IS NULL
  OR (
    type = 'submit_review'
    AND jsonb_typeof(review_findings) = 'array'
  )
);
