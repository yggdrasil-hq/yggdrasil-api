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

export interface BlockingFeature {
  id: string;
  title: string;
  slug: string;
  status: string;
}

export interface BlockingTestRun {
  jobId: string;
  testId: string | null;
}

export interface ProjectDeletionBlocker {
  reason: string;
  features: BlockingFeature[];
  testRuns: BlockingTestRun[];
}

export async function getProjectDeletionBlocker(
  project: Project,
  features: FeatureRepository,
  jobs: JobRepository,
): Promise<ProjectDeletionBlocker | null> {
  const blockingFeatures = await features.listBlocking(project.id);
  if (blockingFeatures.length > 0) {
    return {
      reason: "Wait for active feature runs to finish before deleting this project.",
      features: blockingFeatures.map((feature) => ({
        id: feature.id,
        title: feature.title,
        slug: feature.slug,
        status: feature.status,
      })),
      testRuns: [],
    };
  }

  const activeTestRuns = await jobs.listActiveTestRunsForProject(project.id);
  if (activeTestRuns.length > 0) {
    return {
      reason: "Wait for active test runs to finish before deleting this project.",
      features: [],
      testRuns: activeTestRuns.map((job) => ({ jobId: job.id, testId: job.testId })),
    };
  }

  return null;
}
