-- ADR 024: per-message grill "restart from here".
--
-- Records that a spec_grill job's seed context is a deliberate *rewind* of an
-- earlier session to one transcript turn, and which turn the rewind was taken
-- at. The seed itself still travels in jobs.spec_context (023) — this column
-- exists so the fact is a first-class, queryable property of the job rather
-- than a flag buried inside an opaque JSONB blob that the public API
-- deliberately does not expose (spec_context can hold a whole previous ADR and
-- transcript, so it is not something to hand to the Web app).
--
-- ON DELETE SET NULL: a job must not be destroyed because the specific event it
-- rewound to went away, and a restarted run whose target event is gone is still
-- a restarted run.
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS restarted_from_event_id UUID
    REFERENCES job_events(id) ON DELETE SET NULL;
