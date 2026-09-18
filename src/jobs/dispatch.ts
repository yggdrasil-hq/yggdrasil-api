import type { JobRepository } from "./repository.js";
import type { JobKind, JobTriggerSource } from "./types.js";

/**
 * Stub dispatcher — persists a job row. Orchestrator HTTP integration is TODO.
 */
export async function dispatchJob(
  jobs: JobRepository,
  input: {
    projectId: string;
    kind: JobKind;
    featureId?: string;
    testId?: string;
    testGroup?: "unit" | "integration";
    ref?: string;
    /** How the job came to exist — `manual` is a person pressing "Run now" (issue #31). */
    trigger?: JobTriggerSource;
    designName?: string;
    designSlug?: string;
    designDescription?: string;
    specContext?: Record<string, unknown>;
    /** ADR 022: the Helm revision a `rollback` job should target. */
    targetRevision?: number;
    /** ADR 024: set only by a per-message grill restart — the turn its seed was rewound to. */
    restartedFromEventId?: string;
  },
) {
  return jobs.create(input);
}

/**
 * The partial unique index (migration 043) that makes "one deployment operation
 * per project at a time" a database invariant. Named here rather than inline so
 * the predicate and the constraint it enforces live next to each other in a
 * reader's head.
 */
export const ONE_ACTIVE_DEPLOY_INDEX = "idx_jobs_one_active_deploy_per_project";

/**
 * Whether an insert failed because another deploy/rollback job for the same
 * project is already pending or running.
 *
 * Checked by index name, not by error code alone: `23505` is any unique
 * violation, and treating an unrelated one (or a future constraint's) as "a
 * deployment is already running" would report a data problem as a concurrency
 * one.
 */
export function isActiveDeployConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === "23505" && candidate.constraint === ONE_ACTIVE_DEPLOY_INDEX;
}

/**
 * Dispatches a `deploy` or `rollback` job, or reports that one is already in
 * flight.
 *
 * The routes still pre-check with `findLatestByProjectAndKinds` so the common
 * case gets a clear 409 from the route's own logic; this exists for the window
 * that check cannot cover, where a concurrent request inserted first. Without
 * it the loser of that race would surface as a 500.
 */
export async function dispatchDeployJob(
  jobs: JobRepository,
  input: Parameters<typeof dispatchJob>[1] & { kind: "deploy" | "rollback" },
): Promise<{ job: Awaited<ReturnType<typeof dispatchJob>> } | { conflict: true }> {
  try {
    return { job: await dispatchJob(jobs, input) };
  } catch (error) {
    if (isActiveDeployConflict(error)) return { conflict: true };
    throw error;
  }
}
