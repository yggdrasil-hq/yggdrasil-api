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
  /**
   * ADR 025 item 7: whether this project's Pi jobs load the organization's
   * uploaded extensions. Default off — this is the narrower half of the
   * trust decision, and it must be a deliberate act.
   */
  uploadedExtensionsEnabled: boolean;
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
  organizationId: string;
  name: string;
  slug: string;
  description: string;
  status: ProjectStatus;
  installationId: string | null;
  githubAccessWarning: boolean;
  modelConfigWarning: boolean;
  agenticReviewEnabled: boolean;
  uploadedExtensionsEnabled: boolean;
  hasDesignSurface: boolean;
  /**
   * Issue #31 part 1: the zone this project's test schedules are interpreted in,
   * or `null` for the default (UTC).
   *
   * **Promoted out of `settings` rather than exposing the bag.** `settings` is
   * internal and holds whatever the product wants; a client reading it directly
   * would be coupled to a storage decision, and the next preference added would
   * silently widen the public contract. This is the read half of the write route
   * `PUT /:projectId/timezone` — without it the setting was settable and
   * unreadable, which is precisely the "stored value that nothing reads looks
   * like a feature while doing nothing" failure the issue's own comment warns
   * about.
   */
  timeZone: string | null;
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
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    description: project.description,
    status: project.status,
    installationId: project.installationId,
    githubAccessWarning: project.githubAccessWarning,
    modelConfigWarning: project.modelConfigWarning,
    agenticReviewEnabled: project.agenticReviewEnabled,
    uploadedExtensionsEnabled: project.uploadedExtensionsEnabled,
    hasDesignSurface: project.hasDesignSurface,
    // Read from the JSONB bag here, so the storage choice stays behind this
    // mapper. `typeof` rather than a cast: a value written by something else
    // (or an older shape) must degrade to the default rather than being handed
    // to a client as a zone it will try to display.
    timeZone:
      typeof project.settings?.timezone === "string" ? project.settings.timezone : null,
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
