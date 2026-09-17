-- ADR 023: per-job token/cost accounting, reported by the Orchestrator from
-- Pi's own get_session_stats at the end of a job's session.
--
-- One row per job, keyed on job_id: a retried job is a *new* job row (ADR 012),
-- so a retry gets its own usage row rather than overwriting the attempt it
-- replaced. The upsert makes the endpoint idempotent against a duplicate post.
--
-- project_id and job_kind are denormalized copies of immutable facts about the
-- job: a job's kind and its project never change after the row is created, and
-- both are the primary grouping keys of every read below (so the hot
-- aggregate queries avoid a join). The organization is deliberately NOT copied
-- here — it belongs to the project, not the job, and if a project's
-- organization ever changed, a stored copy would silently misattribute
-- historical usage. Org-scoped reads join `projects` instead.
--
-- cost_usd and duration_ms are nullable on purpose: "the provider reported no
-- cost" is a different fact from "this run was free", and the same holds for a
-- duration. Token columns are NOT NULL DEFAULT 0 — they always come from a
-- provider report, and an absent report is genuinely zero.
--
-- ON DELETE CASCADE on project_id: usage is a per-project operational metric
-- and every read here is project- or org-scoped, so a deleted project's rows
-- have no surface left to appear on. The audit trail (ADR 028) is the durable
-- record, which is exactly what that table is for; org totals therefore drop
-- when a project is deleted. ON DELETE CASCADE on job_id matches: the job row
-- going away is what makes the usage row meaningless.
CREATE TABLE IF NOT EXISTS job_usage (
  job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_kind VARCHAR(32) NOT NULL,
  model_id TEXT,
  provider_name TEXT,
  model_config_source VARCHAR(32),
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6),
  duration_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The two read shapes: org-scoped (join projects, filter by created_at) and
-- project-scoped (filter on the denormalized project_id).
CREATE INDEX IF NOT EXISTS idx_job_usage_project_created_at
  ON job_usage(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_usage_created_at
  ON job_usage(created_at DESC);
