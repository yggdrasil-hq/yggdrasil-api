import type { AuditActionName } from "./actions.js";

/**
 * ADR 028: audit event shapes, plus the pure row-mapping and filter-building
 * helpers the repository and its tests share. Nothing here touches a
 * database, so the filter logic is unit-testable without one.
 */

export const AUDIT_ACTOR_KINDS = ["user", "system", "webhook", "job"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

/** A stored audit_events row, as the repository reads it back. */
export interface AuditEvent {
  id: string;
  organizationId: string;
  projectId: string | null;
  actorUserId: string | null;
  actorKind: AuditActorKind;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: Date;
}

/**
 * A row joined with the display names the trail renders (actor username/
 * display name, project name). Kept out of the table itself: names change
 * and should be resolved at read time, not frozen into history.
 */
export interface AuditEventWithNames extends AuditEvent {
  projectName: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
}

export interface PublicAuditEvent {
  id: string;
  organizationId: string;
  projectId: string | null;
  projectName: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  actorDisplayName: string | null;
  actorKind: AuditActorKind;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

export function toPublicAuditEvent(event: AuditEventWithNames): PublicAuditEvent {
  return {
    id: event.id,
    organizationId: event.organizationId,
    projectId: event.projectId,
    projectName: event.projectName,
    actorUserId: event.actorUserId,
    actorUsername: event.actorUsername,
    actorDisplayName: event.actorDisplayName,
    actorKind: event.actorKind,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    metadata: event.metadata,
    ip: event.ip,
    createdAt: event.createdAt.toISOString(),
  };
}

/** The write side: one recorded mutation. */
export interface AuditEventInput {
  organizationId: string;
  projectId?: string | null;
  actorUserId?: string | null;
  actorKind?: AuditActorKind;
  action: AuditActionName;
  targetType?: string | null;
  targetId?: string | null;
  /** Structured context about the mutation. Never secret plaintext. */
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

/**
 * The read side's filters (ADR 028 item 7). `action` is a prefix match, so
 * `project` returns every project.* event while `project.deleted` returns
 * just that one.
 */
export interface AuditListFilters {
  projectId?: string;
  actorUserId?: string;
  action?: string;
  from?: Date;
  to?: Date;
}

export interface AuditListOptions extends AuditListFilters {
  limit: number;
  offset: number;
}

export interface AuditListResult {
  events: AuditEventWithNames[];
  total: number;
}

/** Default/cap page sizes for GET /organizations/:id/audit. */
export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;

/**
 * The alias every caller of `buildAuditWhere` must give `audit_events`.
 *
 * **This exists because the predicates used to be unqualified, and that is not
 * a style question — it was a 500 on every audit read (issue #61).**
 *
 * `listForOrganization` runs one clause against two queries: a `COUNT(*)` with
 * no join, and a page query that `LEFT JOIN`s `projects` and `users`. Both
 * tables have an `organization_id` column and all three have `created_at`, so
 * `organization_id = $1` resolved in the count query and was **ambiguous** in
 * the page query (`42702`). The count query succeeding is not enough to save the
 * request — the two run in `Promise.all`, so the page query's rejection failed
 * the whole thing. Every audit list request 500'd, always, and no unit test
 * noticed because they assert the generated string rather than executing it.
 *
 * The alias is named once here rather than typed as a literal `e.` in each
 * condition, and `repository.ts` interpolates nothing — instead a test asserts
 * the queries alias `audit_events` to this same name, so the clause and the
 * `FROM` cannot drift apart silently. `EVENT_COLUMNS` already used `e.`-prefixed
 * names, so this is the convention this module already had; it just was not
 * applied to the predicates.
 */
export const AUDIT_EVENTS_ALIAS = "e";

/**
 * Builds the WHERE clause shared by the list and count queries, so the two
 * can never drift apart. Values are positional ($n) starting after the
 * always-present organization id.
 *
 * **Every column is alias-qualified.** Callers must alias `audit_events` to
 * `AUDIT_EVENTS_ALIAS`; see that constant for why this is load-bearing rather
 * than cosmetic. `project_id`, `actor_user_id` and `action` exist only on
 * `audit_events` today and would resolve unqualified, but they are qualified
 * anyway: a column added to a joined table later must not be able to turn a
 * working filter into a 500, and the inconsistency is how the two that *are*
 * ambiguous got missed.
 *
 * Pure — the filter logic the repository test covers without a database — but
 * note that purity is exactly why the unit tests could not catch #61. The
 * execution check is `scripts/verify/issue-61-audit-query.mts` and the
 * Postgres-backed cases in `audit/repository.test.ts`.
 */
export function buildAuditWhere(
  organizationId: string,
  filters: AuditListFilters,
): { clause: string; values: unknown[] } {
  const a = AUDIT_EVENTS_ALIAS;
  const values: unknown[] = [organizationId];
  const conditions = [`${a}.organization_id = $1`];

  if (filters.projectId) {
    values.push(filters.projectId);
    conditions.push(`${a}.project_id = $${values.length}`);
  }
  if (filters.actorUserId) {
    values.push(filters.actorUserId);
    conditions.push(`${a}.actor_user_id = $${values.length}`);
  }
  if (filters.action) {
    // Prefix match: 'project' matches 'project.created' and
    // 'project.repository_linked' alike. `%`/`_` in the input are escaped so
    // a caller can't widen their own filter with LIKE wildcards.
    values.push(`${escapeLikePattern(filters.action)}%`);
    conditions.push(`${a}.action LIKE $${values.length} ESCAPE '\\'`);
  }
  if (filters.from) {
    values.push(filters.from);
    conditions.push(`${a}.created_at >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    conditions.push(`${a}.created_at <= $${values.length}`);
  }

  return { clause: conditions.join(" AND "), values };
}

/** Escapes LIKE metacharacters so a filter value is matched literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
