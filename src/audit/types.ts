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
 * Builds the WHERE clause shared by the list and count queries, so the two
 * can never drift apart. Values are positional ($n) starting after the
 * always-present organization id. Pure — this is the filter logic the
 * repository test covers without a database.
 */
export function buildAuditWhere(
  organizationId: string,
  filters: AuditListFilters,
): { clause: string; values: unknown[] } {
  const values: unknown[] = [organizationId];
  const conditions = ["organization_id = $1"];

  if (filters.projectId) {
    values.push(filters.projectId);
    conditions.push(`project_id = $${values.length}`);
  }
  if (filters.actorUserId) {
    values.push(filters.actorUserId);
    conditions.push(`actor_user_id = $${values.length}`);
  }
  if (filters.action) {
    // Prefix match: 'project' matches 'project.created' and
    // 'project.repository_linked' alike. `%`/`_` in the input are escaped so
    // a caller can't widen their own filter with LIKE wildcards.
    values.push(`${escapeLikePattern(filters.action)}%`);
    conditions.push(`action LIKE $${values.length} ESCAPE '\\'`);
  }
  if (filters.from) {
    values.push(filters.from);
    conditions.push(`created_at >= $${values.length}`);
  }
  if (filters.to) {
    values.push(filters.to);
    conditions.push(`created_at <= $${values.length}`);
  }

  return { clause: conditions.join(" AND "), values };
}

/** Escapes LIKE metacharacters so a filter value is matched literally. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
