import type { FeatureRepository } from "../features/repository.js";
import type { JobRepository } from "../jobs/repository.js";
import type { Project } from "./types.js";

export async function getRepositoryRemovalBlockedReason(
  project: Project,
  features: FeatureRepository,
  jobs: JobRepository,
): Promise<string | null> {
  if (project.status === "initializing") {
    return "Finish project initialization before removing repositories.";
  }

  if (await features.hasBlockingStatuses(project.id)) {
    return "Wait for active feature runs to finish before removing repositories.";
  }

  if (await jobs.hasActiveTestRunsForProject(project.id)) {
    return "Wait for active test runs to finish before removing repositories.";
  }

  return null;
}
