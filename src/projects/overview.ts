import type { FeatureRepository } from "../features/repository.js";
import type { Feature } from "../features/types.js";
import type { JobRepository } from "../jobs/repository.js";
import type { TestRepository } from "../tests/repository.js";
import type {
  ActionQueueItem,
  FeatureCounts,
  ProjectOverview,
} from "./types.js";
import { getFeatureBucket } from "./types.js";

export async function buildProjectOverview(deps: {
  projectId: string;
  projectSlug: string;
  githubAccessWarning: boolean;
  modelConfigWarning: boolean;
  features: FeatureRepository;
  jobs: JobRepository;
  tests: TestRepository;
}): Promise<ProjectOverview> {
  const featureList = await deps.features.listByProject(deps.projectId);
  const counts: FeatureCounts = { planned: 0, inProgress: 0, completed: 0 };

  for (const feature of featureList) {
    const bucket = getFeatureBucket(feature.status);
    if (bucket === "planned") counts.planned += 1;
    if (bucket === "inProgress") counts.inProgress += 1;
    if (bucket === "completed") counts.completed += 1;
  }

  const actionQueue = buildActionQueue(
    featureList,
    deps.projectId,
    deps.githubAccessWarning,
    deps.modelConfigWarning,
    await deps.jobs.listRecentFailedTestRuns(deps.projectId),
    await deps.tests.listByProject(deps.projectId),
  );

  return { counts, actionQueue };
}

function buildActionQueue(
  features: Feature[],
  projectId: string,
  githubAccessWarning: boolean,
  modelConfigWarning: boolean,
  failedTestJobs: Awaited<ReturnType<JobRepository["listRecentFailedTestRuns"]>>,
  tests: Awaited<ReturnType<TestRepository["listByProject"]>>,
): ActionQueueItem[] {
  const items: ActionQueueItem[] = [];

  if (githubAccessWarning) {
    items.push({
      type: "fix_github_access",
      title: "Fix GitHub access",
      waitingSince: new Date().toISOString(),
      linkPath: `/projects/${projectId}/settings`,
    });
  }

  if (modelConfigWarning) {
    items.push({
      type: "fix_model_configuration",
      title: "Fix model configuration",
      waitingSince: new Date().toISOString(),
      linkPath: `/projects/${projectId}/settings`,
    });
  }

  for (const feature of features) {
    const basePath = `/projects/${projectId}/features/${feature.id}`;

    if (feature.status === "draft" && feature.awaitingUserInput) {
      items.push({
        type: "grill_response_needed",
        featureId: feature.id,
        title: feature.title,
        waitingSince: feature.updatedAt.toISOString(),
        linkPath: basePath,
      });
      continue;
    }

    if (feature.status === "spec_ready" && !feature.adrApproved) {
      items.push({
        type: "adr_review",
        featureId: feature.id,
        title: feature.title,
        waitingSince: feature.updatedAt.toISOString(),
        linkPath: basePath,
      });
      continue;
    }

    if (feature.status === "spec_ready" && feature.adrApproved) {
      items.push({
        type: "start_build",
        featureId: feature.id,
        title: feature.title,
        waitingSince: feature.updatedAt.toISOString(),
        linkPath: basePath,
      });
      continue;
    }

    if (feature.status === "in_review") {
      items.push({
        type: "pr_review",
        featureId: feature.id,
        title: feature.title,
        waitingSince: feature.updatedAt.toISOString(),
        linkPath: feature.prUrl ?? basePath,
      });
      continue;
    }

    if (feature.status === "returned") {
      items.push({
        type: "changes_requested",
        featureId: feature.id,
        title: feature.title,
        waitingSince: feature.updatedAt.toISOString(),
        linkPath: basePath,
      });
      continue;
    }

    if (feature.status === "testing") {
      items.push({
        type: "test_failure",
        featureId: feature.id,
        title: feature.title,
        waitingSince: feature.updatedAt.toISOString(),
        linkPath: basePath,
      });
      continue;
    }

    if (feature.status === "failed") {
      items.push({
        type: "failed_build",
        featureId: feature.id,
        title: feature.title,
        waitingSince: feature.updatedAt.toISOString(),
        linkPath: basePath,
      });
    }
  }

  const testsById = new Map(tests.map((test) => [test.id, test]));
  for (const job of failedTestJobs) {
    if (!job.testId) continue;
    const test = testsById.get(job.testId);
    if (!test) continue;

    items.push({
      type: "test_failure",
      testId: test.id,
      title: test.name,
      waitingSince: (job.completedAt ?? job.createdAt).toISOString(),
      linkPath: `/projects/${projectId}/tests/${test.id}`,
    });
  }

  items.sort(
    (a, b) => new Date(a.waitingSince).getTime() - new Date(b.waitingSince).getTime(),
  );

  return items;
}
