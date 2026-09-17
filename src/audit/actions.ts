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
  /**
   * ADR 022: a primary-deployment rollback was requested. Recorded even though
   * the resulting job row also exists, because the job row carries no actor —
   * and "who sent production back to an older revision, and when" is exactly
   * what an audit trail is for. Note the routine `POST /deploy` trigger is
   * still deliberately unaudited (ADR 028's out-of-scope table); the asymmetry
   * is intentional and explained in ADR 022.
   */
  deployRolledBack: "deploy.rolled_back",

  // --- Features / the six-stage lifecycle (ADR 015) ---
  featureCreated: "feature.created",
  featureAdrApproved: "feature.adr_approved",
  featureBuildStarted: "feature.build_started",
  featureCancelled: "feature.cancelled",
  featureRestarted: "feature.restarted",
  featureGrillRetried: "feature.grill_retried",
  /**
   * ADR 024: the Spec interview was rewound to an earlier transcript turn and
   * re-run from there. Recorded separately from `feature.grill_retried` (which
   * re-runs the interview from scratch) because the two discard very different
   * amounts of work — a rewind keeps the turns before the chosen message — and
   * an audit reader needs to tell them apart.
   */
  featureGrillRestartedFromMessage: "feature.grill_restarted_from_message",
  featureBuildRetried: "feature.build_retried",
  featureResumed: "feature.resumed",

  // --- Project config (ADR 004 secrets, ADR 018 model overrides) ---
  projectSecretUpdated: "project_secret.updated",
  projectSecretDeleted: "project_secret.deleted",
  projectModelOverrideSet: "project_model_override.set",
  projectModelOverrideCleared: "project_model_override.cleared",

  // --- Designs (ADR 014 sessions, ADR 020 persistence) ---
  // Finalization is deliberately absent: it is driven by `submit_design`
  // arriving on the internal job-event route, which ADR 028 keeps out of scope
  // along with every other `/internal/*` write.
  designSessionStarted: "design.session_started",
  designSessionCancelled: "design.session_cancelled",

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

  // --- Resource allocation caps (ADR 030) ---
  projectTokenCapSet: "project_token_cap.set",
  projectResourceQuotaSet: "project_resource_quota.set",

  // --- GitHub App install / repo access (ADR 005) ---
  githubReposSynced: "github.repos_synced",
  githubInstallationUpdated: "github.installation_updated",
  githubRepositoriesUpdated: "github.repositories_updated",
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
