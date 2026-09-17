-- ADR 030: resource allocation caps.
--
-- Two independent, admin-set per-project limits. Both are stored as *overrides*:
-- a project with no row falls back to the platform defaults, which is why
-- neither table carries a default value of its own.
--
-- 1. project_token_caps -- the monthly token ceiling a project may draw from
--    the organization's own provider credential (ADR 018: providers are
--    bring-your-own-key and org-owned, so this meters rather than bills).
--    NULL is not representable here on purpose: a missing row means "uncapped",
--    and a row with 0 is a deliberate, different fact -- "spend nothing further
--    this period". Enforcement (ADR 030 §4) treats them distinctly.
--
-- 2. project_resource_quotas -- the per-namespace Kubernetes ResourceQuota
--    applied to the project's namespace (ADR 003 §5-6 put one namespace per
--    project; §17 sizes a quota for the primary deployment plus a small number
--    of temporary-deployment slots).
--
--    CPU and memory are stored normalized -- millicores and MiB -- rather than
--    as Kubernetes quantity strings. Quantity syntax ("500m", "0.5Gi", "1e3")
--    is a wide surface to validate and a wide surface to get wrong; integers
--    are exactly representable, trivially validated, and formatted into
--    quantities by the one component that actually talks to Kubernetes
--    (orchestrator/internal/k8s), so the syntax lives where it is consumed
--    instead of being round-tripped through the API.

CREATE TABLE IF NOT EXISTS project_token_caps (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  monthly_token_cap BIGINT NOT NULL CHECK (monthly_token_cap >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_resource_quotas (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  cpu_millicores INTEGER NOT NULL CHECK (cpu_millicores > 0),
  memory_mib INTEGER NOT NULL CHECK (memory_mib > 0),
  pods INTEGER NOT NULL CHECK (pods > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The cap read is "this project's spend in the current period", served by
-- idx_job_usage_project_created_at (migration 036) -- no new index needed here.
