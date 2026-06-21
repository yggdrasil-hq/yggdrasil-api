export type ProjectStatus = "initializing" | "ready";

export interface ProjectRepositoryRecord {
  id: string;
  githubOwner: string;
  githubRepo: string;
  isPrimary: boolean;
  sortOrder: number;
}

export interface Project {
  id: string;
  ownerUserId: string;
  name: string;
  slug: string;
  description: string;
  status: ProjectStatus;
  settings: Record<string, unknown>;
  repositories: ProjectRepositoryRecord[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicProjectRepository {
  id: string;
  githubOwner: string;
  githubRepo: string;
  isPrimary: boolean;
}

export interface PublicProject {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: ProjectStatus;
  repositories: PublicProjectRepository[];
}

export interface FeatureCounts {
  planned: number;
  inProgress: number;
  completed: number;
}

export type ActionQueueType =
  | "grill_response_needed"
  | "adr_review"
  | "start_build"
  | "pr_review"
  | "changes_requested"
  | "test_failure"
  | "failed_build";

export interface ActionQueueItem {
  type: ActionQueueType;
  featureId?: string;
  testId?: string;
  title: string;
  waitingSince: string;
  linkPath: string;
}

export interface ProjectOverview {
  counts: FeatureCounts;
  actionQueue: ActionQueueItem[];
}

export function toPublicProject(project: Project): PublicProject {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    status: project.status,
    repositories: project.repositories.map((repo) => ({
      id: repo.id,
      githubOwner: repo.githubOwner,
      githubRepo: repo.githubRepo,
      isPrimary: repo.isPrimary,
    })),
  };
}

export function getFeatureBucket(
  status: string,
): "planned" | "inProgress" | "completed" | null {
  if (status === "draft" || status === "spec_ready") {
    return "planned";
  }
  if (
    status === "queued" ||
    status === "running" ||
    status === "in_review" ||
    status === "changes_requested" ||
    status === "failed"
  ) {
    return "inProgress";
  }
  if (status === "merged" || status === "cancelled") {
    return "completed";
  }
  return null;
}
