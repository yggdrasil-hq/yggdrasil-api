/**
 * Notification preferences (ADR 027) — the pure decision layer.
 *
 * Kept separate from the repositories on purpose: "should this user be told
 * about this event?" is the one rule worth testing exhaustively, and it has no
 * reason to need a database to answer. The repositories load rows and delegate
 * here; routes serialize the registry below.
 */

/**
 * The notification kinds the API actually creates today, as the single source
 * of truth for what a preference row may name.
 *
 * This list is deliberately narrower than the product's job kinds: `spec_grill`,
 * `feature_build`, `test_run`, `agentic_review`, `design_grill` and `deploy` are
 * jobs, and completing one does not currently create a notification. Only the
 * five kinds below are passed to `NotificationRepository.create` anywhere in
 * `src/` (see the ADR's coverage table). Adding a toggle for a kind that can
 * never fire would show users a switch with no effect, so a kind joins this list
 * only once something actually creates it — at which point it is a one-line
 * change here and the row appears in the settings UI.
 */
export const NOTIFICATION_KINDS = [
  "project_created",
  "chart_scaffold_failed",
  "feature_created",
  "adr_approved",
  "build_started",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  project_created: "Project created",
  chart_scaffold_failed: "Helm chart scaffolding failed",
  feature_created: "Feature created (spec grill started)",
  adr_approved: "ADR approved",
  build_started: "Build started",
};

export const NOTIFICATION_KIND_DESCRIPTIONS: Record<NotificationKind, string> = {
  project_created: "When a new project is created in the organization.",
  chart_scaffold_failed:
    "When the Helm chart could not be scaffolded for a new project.",
  feature_created: "When a feature is created and its spec grill starts.",
  adr_approved: "When a feature's ADR is approved and it is ready to build.",
  build_started: "When an implementation build starts for a feature.",
};

/** A row of `notification_preferences`. `kind: null` is the org-wide row. */
export interface NotificationPreference {
  id: string;
  userId: string;
  organizationId: string;
  kind: string | null;
  enabled: boolean;
}

/**
 * Whether a notification should be recorded for this user.
 *
 * Default is **notify**: a user with no preference rows and no mute keeps
 * receiving everything, which is what every notification path did before
 * preferences existed. Only an explicit row suppresses.
 *
 * Precedence, most specific first:
 *   1. a per-project mute suppresses regardless of kind (an explicit "not this
 *      project" outranks any kind-level setting);
 *   2. a row for the exact kind;
 *   3. the org-wide row (`kind: null`);
 *   4. otherwise notify.
 *
 * `projectId: null` can never be muted: a mute is keyed by project, so a
 * notification that names no project has nothing to match against and is
 * governed only by its org/kind row.
 */
export function shouldNotify(input: {
  kind: string;
  projectId: string | null;
  projectMuted: boolean;
  preferences: Array<Pick<NotificationPreference, "kind" | "enabled">>;
}): boolean {
  const { kind, projectId, projectMuted, preferences } = input;

  if (projectId !== null && projectMuted) return false;

  const kindRow = preferences.find((row) => row.kind === kind);
  if (kindRow) return kindRow.enabled;

  const allKindsRow = preferences.find((row) => row.kind === null);
  if (allKindsRow) return allKindsRow.enabled;

  return true;
}

/**
 * The effective enabled state of one kind for a user, as shown in settings.
 * The same precedence as `shouldNotify` minus the project dimension, so the UI
 * and the write path can never disagree about what "on" means.
 */
export function isKindEnabled(
  kind: string,
  preferences: Array<Pick<NotificationPreference, "kind" | "enabled">>,
): boolean {
  return shouldNotify({
    kind,
    projectId: null,
    projectMuted: false,
    preferences,
  });
}

/** True when a row enables the whole organization (the master toggle). */
export function isMasterPreference(
  row: Pick<NotificationPreference, "kind">,
): boolean {
  return row.kind === null;
}

export function isKnownNotificationKind(kind: string): kind is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(kind);
}
