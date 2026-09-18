-- Issue #31 part 2: a manual "Run now" for a Test entity.
--
-- ADR 026 follow-up 4 deliberately skipped this: it is a *new mutating endpoint*,
-- so it needs new authorization surface and an ADR 028 audit row, and it was
-- outside that ADR's scope. The absence is the first thing a user asks for after
-- fixing a failing suite, because otherwise they wait up to a full interval to
-- find out whether the fix worked.
--
-- ## Why the trigger source needs a third value rather than reusing `schedule`
--
-- A manual run is dispatched on exactly the same terms as a scheduled one — same
-- kind, same `ref: "main"`, no feature — so the tempting shortcut is to record it
-- as `schedule` and save a migration. That would make the run history lie in the
-- one place it is read: `runTriggerLabel` in the Web app renders "Scheduled" for
-- `schedule`, so a run a person deliberately started would be attributed to the
-- scheduler, and "why did this run happen?" — the question history exists to
-- answer — would have no answer for it.
--
-- `NULL` is also not the answer. It already means "this job kind has no trigger
-- source" (every `deploy`, `spec_grill` and `agentic_review` row), so reusing it
-- would conflate "not applicable" with "a human asked".
--
-- Widened, not replaced, like 019 and every other constraint change here: this
-- only adds an allowed value, so every existing row stays valid and the migration
-- is safe to apply to a database that is mid-run.
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_trigger_source_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_trigger_source_check
  CHECK (trigger_source IS NULL OR trigger_source IN ('feature', 'schedule', 'manual'));
