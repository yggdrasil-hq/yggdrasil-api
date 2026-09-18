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
   * ADR 022: a primary deployment was triggered by hand (issue #26). Recorded
   * alongside `deploy.rolled_back` so the two operator-initiated deployment
   * actions read symmetrically in the trail. The routine push-driven deploy is
   * still deliberately unaudited (ADR 028's out-of-scope table, ADR 022 §8):
   * it has no actor to name and would add a row per push to `main`.
   */
  deployTriggered: "deploy.triggered",
  /**
   * ADR 022: a primary-deployment rollback was requested. Recorded even though
   * the resulting job row also exists, because the job row carries no actor —
   * and "who sent production back to an older revision, and when" is exactly
   * what an audit trail is for.
   */
  deployRolledBack: "deploy.rolled_back",

  /**
   * Issue #31, ADR 026 follow-up 4: a person pressed "Run now" on a Test.
   *
   * Audited where the *scheduled* dispatch deliberately is not, and the
   * distinction is the same one ADR 022 §8 draws for deploys: a scheduled run has
   * no actor to name — the schedule is the actor, and it would add a row per
   * window — whereas a manual run exists because a specific person decided the
   * suite should run *now*. "Who started this, and why is it running at 3pm when
   * it runs at 9am?" is exactly what a trail is for, and the `jobs` row answers
   * neither question.
   */
  testRunTriggered: "test.run_triggered",

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

  // --- Uploaded Pi extensions (ADR 025) ---
  /**
   * ADR 025: code uploaded by an org admin that will run inside job
   * containers holding the project's GitHub token and the org's model key.
   * These three are the highest-signal events in this file for anyone
   * answering "what changed before that happened" — an extension arriving,
   * being switched off, or being replaced is exactly the kind of change a
   * post-incident reader needs to see.
   *
   * A replacement records `extension.uploaded` with `replaced: true` in its
   * metadata rather than a separate action: it is the same act on the same
   * target, and splitting it would make "every revision of extension X" a
   * two-filter query. The digest in metadata is what distinguishes revisions.
   */
  extensionUploaded: "extension.uploaded",
  extensionActivationChanged: "extension.activation_changed",
  extensionDeleted: "extension.deleted",
  /**
   * Enabling uploaded extensions in a project is recorded on its own action
   * rather than folded into `project.updated` (which is what the analogous
   * agentic-review toggle does). The difference is intent: this toggle decides
   * whether arbitrary third-party code runs with the project's credentials,
   * and a reader scanning a trail for "when did we start doing that here"
   * should not have to open every project update to find out.
   */
  projectUploadedExtensionsChanged: "project.uploaded_extensions_changed",
} as const;

export type AuditActionName = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
