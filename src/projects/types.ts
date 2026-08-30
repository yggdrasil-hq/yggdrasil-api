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
  /** The Organization that owns this project (ADR 016 item 4). */
  organizationId: string;
  /** The user who created the project — retained as a reference, not an ownership key. */
  ownerUserId: string;
  name: string;
  slug: string;
  description: string;
  status: ProjectStatus;
  settings: Record<string, unknown>;
  installationId: string | null;
  githubAccessWarning: boolean;
  modelConfigWarning: boolean;
  /** ADR 015 item 12: Agentic Review gate per-project, default on. */
  agenticReviewEnabled: boolean;
  /** ADR 014: whether this project has a user-facing design surface. */
  hasDesignSurface: boolean;
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
  installationId: string | null;
  githubAccessWarning: boolean;
  modelConfigWarning: boolean;
  agenticReviewEnabled: boolean;
  hasDesignSurface: boolean;
  repositories: PublicProjectRepository[];
  repositoryRemovalBlockedReason: string | null;
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
  | "failed_build"
  | "fix_github_access"
  | "fix_model_configuration";

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

export function toPublicProject(
  project: Project,
  repositoryRemovalBlockedReason: string | null = null,
): PublicProject {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    status: project.status,
    installationId: project.installationId,
    githubAccessWarning: project.githubAccessWarning,
    modelConfigWarning: project.modelConfigWarning,
    agenticReviewEnabled: project.agenticReviewEnabled,
    hasDesignSurface: project.hasDesignSurface,
    repositories: project.repositories.map((repo) => ({
      id: repo.id,
      githubOwner: repo.githubOwner,
      githubRepo: repo.githubRepo,
      isPrimary: repo.isPrimary,
    })),
    repositoryRemovalBlockedReason,
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
    status === "testing" ||
    status === "agentic_review" ||
    status === "in_review" ||
    status === "returned" ||
    status === "failed"
  ) {
    return "inProgress";
  }
  if (status === "merged" || status === "cancelled") {
    return "completed";
  }
  return null;
}
