import { describe, expect, it } from "vitest";
import {
  getProjectDeletionBlocker,
  getRepositoryRemovalBlockedReason,
} from "./repository-removal.js";
import type { Project } from "./types.js";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    organizationId: "org_1",
    ownerUserId: "user_1",
    name: "Test",
    slug: "test",
    description: "",
    status: "ready",
    settings: {},
    installationId: null,
    githubAccessWarning: false,
    modelConfigWarning: false,
    agenticReviewEnabled: true,
    uploadedExtensionsEnabled: false,
    hasDesignSurface: true,
    repositories: [
      {
        id: "repo_1",
        githubOwner: "acme",
        githubRepo: "web",
        isPrimary: true,
        sortOrder: 0,
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("getRepositoryRemovalBlockedReason", () => {
  it("blocks removal while project is initializing", async () => {
    const project = makeProject({ status: "initializing" });
    const features = {
      hasBlockingStatuses: async () => false,
    };
    const jobs = {
      hasActiveTestRunsForProject: async () => false,
    };

    await expect(
      getRepositoryRemovalBlockedReason(
        project,
        features as never,
        jobs as never,
      ),
    ).resolves.toBe("Finish project initialization before removing repositories.");
  });

  it("blocks removal while features are active", async () => {
    const project = makeProject();
    const features = {
      hasBlockingStatuses: async () => true,
    };
    const jobs = {
      hasActiveTestRunsForProject: async () => false,
    };

    await expect(
      getRepositoryRemovalBlockedReason(
        project,
        features as never,
        jobs as never,
      ),
    ).resolves.toBe(
      "Wait for active feature runs to finish before removing repositories.",
    );
  });

  it("blocks removal while test runs are active", async () => {
    const project = makeProject();
    const features = {
      hasBlockingStatuses: async () => false,
    };
    const jobs = {
      hasActiveTestRunsForProject: async () => true,
    };

    await expect(
      getRepositoryRemovalBlockedReason(
        project,
        features as never,
        jobs as never,
      ),
    ).resolves.toBe(
      "Wait for active test runs to finish before removing repositories.",
    );
  });

  it("allows removal when project is ready and idle", async () => {
    const project = makeProject();
    const features = {
      hasBlockingStatuses: async () => false,
    };
    const jobs = {
      hasActiveTestRunsForProject: async () => false,
    };

    await expect(
      getRepositoryRemovalBlockedReason(
        project,
        features as never,
        jobs as never,
      ),
    ).resolves.toBeNull();
  });
});

describe("getProjectDeletionBlocker", () => {
  it("blocks deletion while features are active, naming them", async () => {
    const project = makeProject();
    const blockingFeature = {
      id: "feat_1",
      title: "Checkout flow",
      slug: "checkout-flow",
      status: "running",
    };
    const features = {
      listBlocking: async () => [blockingFeature],
    };
    const jobs = {
      listActiveTestRunsForProject: async () => [],
    };

    await expect(
      getProjectDeletionBlocker(project, features as never, jobs as never),
    ).resolves.toEqual({
      reason: "Wait for active feature runs to finish before deleting this project.",
      features: [blockingFeature],
      testRuns: [],
    });
  });

  it("blocks deletion while test runs are active, naming them", async () => {
    const project = makeProject();
    const features = {
      listBlocking: async () => [],
    };
    const jobs = {
      listActiveTestRunsForProject: async () => [
        { id: "job_1", testId: "test_1" },
      ],
    };

    await expect(
      getProjectDeletionBlocker(project, features as never, jobs as never),
    ).resolves.toEqual({
      reason: "Wait for active test runs to finish before deleting this project.",
      features: [],
      testRuns: [{ jobId: "job_1", testId: "test_1" }],
    });
  });

  it("allows deletion when project is idle", async () => {
    const project = makeProject();
    const features = {
      listBlocking: async () => [],
    };
    const jobs = {
      listActiveTestRunsForProject: async () => [],
    };

    await expect(
      getProjectDeletionBlocker(project, features as never, jobs as never),
    ).resolves.toBeNull();
  });
});
