/**
 * ADR 028: audit logging / trails. Every action string the API can record is
 * registered here, once — route handlers reference the constant, tests assert
 * on it, and the Web app's label map keys off it, so there is exactly one
 * spelling per action.
 *
 * Naming: `<domain>.<verb_in_past_tense>`, where domain is the resource family
 * the mutation belongs to. The Web app groups and labels by the part before
 * the dot (see web/lib/features/audit.ts).
 */
export const AUDIT_ACTIONS = {
  // --- Projects (ADR 002, ADR 016 item 4) ---
  projectCreated: "project.created",
  projectUpdated: "project.updated",
  projectDeleted: "project.deleted",
  projectRepositoryLinked: "project.repository_linked",
  projectRepositoryUnlinked: "project.repository_unlinked",
  projectMarkedReady: "project.marked_ready",
  projectChartScaffoldFailed: "project.chart_scaffold_failed",

  // --- Features / the six-stage lifecycle (ADR 015) ---
  featureCreated: "feature.created",
  featureAdrApproved: "feature.adr_approved",
  featureBuildStarted: "feature.build_started",
  featureCancelled: "feature.cancelled",
  featureRestarted: "feature.restarted",
  featureGrillRetried: "feature.grill_retried",
  featureBuildRetried: "feature.build_retried",
  featureResumed: "feature.resumed",

  // --- Project config (ADR 004 secrets, ADR 018 model overrides) ---
  projectSecretUpdated: "project_secret.updated",
  projectSecretDeleted: "project_secret.deleted",
  projectModelOverrideSet: "project_model_override.set",
  projectModelOverrideCleared: "project_model_override.cleared",

  // --- Organization, RBAC, cluster (ADR 016) ---
  orgCreated: "org.created",
  orgUpdated: "org.updated",
  orgInviteCreated: "org.invite_created",
  orgInviteRevoked: "org.invite_revoked",
  orgMemberJoined: "org.member_joined",
  orgRoleChanged: "org.role_changed",
  orgMemberRemoved: "org.member_removed",
  orgClusterSet: "org.cluster_set",
  orgClusterRemoved: "org.cluster_removed",
  orgSecretSet: "org.secret_set",
  orgSecretDeleted: "org.secret_deleted",

  // --- Model configuration (ADR 018) ---
  modelProviderCreated: "model_provider.created",
  modelProviderUpdated: "model_provider.updated",
  modelProviderDeleted: "model_provider.deleted",
  modelCreated: "model.created",
  modelUpdated: "model.updated",
  modelDeleted: "model.deleted",
  jobModelDefaultSet: "job_model_default.set",
  jobModelDefaultCleared: "job_model_default.cleared",

  // --- GitHub App install / repo access (ADR 005) ---
  githubReposSynced: "github.repos_synced",
  githubInstallationUpdated: "github.installation_updated",
  githubRepositoriesUpdated: "github.repositories_updated",
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
