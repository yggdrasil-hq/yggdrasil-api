import type { JobRepository } from "./repository.js";
import type { JobKind } from "./types.js";

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
    trigger?: "feature" | "schedule";
    designName?: string;
    designSlug?: string;
    designDescription?: string;
  },
) {
  return jobs.create(input);
}
