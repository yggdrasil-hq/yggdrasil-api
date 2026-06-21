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
  },
) {
  return jobs.create(input);
}
