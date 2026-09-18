import type pg from "pg";
import {
  AUDIT_EVENTS_ALIAS,
  buildAuditWhere,
  type AuditEvent,
  type AuditEventInput,
  type AuditEventWithNames,
  type AuditListOptions,
  type AuditListResult,
} from "./types.js";

interface AuditEventRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  created_at: Date;
}

interface AuditEventWithNamesRow extends AuditEventRow {
  project_name: string | null;
  actor_username: string | null;
  actor_display_name: string | null;
}

/**
 * Columns shared by every read, so the two queries can't drift.
 *
 * The `e.` prefix is `AUDIT_EVENTS_ALIAS`, which every query below must use as
 * the alias for `audit_events` — `buildAuditWhere` qualifies its predicates with
 * that same name, and the two disagreeing is issue #61: an unqualified
 * `organization_id` resolved in the join-free count query and was ambiguous in
 * the joined page query, so every audit read 500'd. The alias is a contract
 * between this file and `types.ts`, not a local naming choice.
 */
const EVENT_COLUMNS = `
  e.id, e.organization_id, e.project_id, e.actor_user_id, e.actor_kind,
  e.action, e.target_type, e.target_id, e.metadata, e.ip, e.created_at
`;

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    actorUserId: row.actor_user_id,
    actorKind: row.actor_kind as AuditEvent["actorKind"],
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata ?? {},
    ip: row.ip,
    createdAt: row.created_at,
  };
}

function toAuditEventWithNames(row: AuditEventWithNamesRow): AuditEventWithNames {
  return {
    ...toAuditEvent(row),
    projectName: row.project_name,
    actorUsername: row.actor_username,
    actorDisplayName: row.actor_display_name,
  };
}

/**
 * ADR 028: the audit trail's storage. Writes are append-only — there is no
 * update or delete path anywhere in this class, by design (the trail is
 * immutable and kept indefinitely).
 */
export class AuditEventRepository {
  constructor(private readonly db: pg.Pool) {}

  async create(input: AuditEventInput): Promise<AuditEvent> {
    const { rows } = await this.db.query<AuditEventRow>(
      `INSERT INTO audit_events
         (organization_id, project_id, actor_user_id, actor_kind, action,
          target_type, target_id, metadata, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING id, organization_id, project_id, actor_user_id, actor_kind,
                 action, target_type, target_id, metadata, ip, created_at`,
      [
        input.organizationId,
        input.projectId ?? null,
        input.actorUserId ?? null,
        input.actorKind ?? "user",
        input.action,
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.ip ?? null,
      ],
    );
    return toAuditEvent(rows[0]);
  }

  /**
   * One page of an org's trail, newest first, plus the total matching count
   * for the same filters (so the Web app can page without guessing).
   */
  async listForOrganization(
    organizationId: string,
    options: AuditListOptions,
  ): Promise<AuditListResult> {
    const { clause, values } = buildAuditWhere(organizationId, options);

    const listQuery = this.db.query<AuditEventWithNamesRow>(
      `SELECT ${EVENT_COLUMNS},
              p.name AS project_name,
              u.username AS actor_username,
              u.display_name AS actor_display_name
         FROM audit_events ${AUDIT_EVENTS_ALIAS}
         LEFT JOIN projects p ON p.id = ${AUDIT_EVENTS_ALIAS}.project_id
         LEFT JOIN users u ON u.id = ${AUDIT_EVENTS_ALIAS}.actor_user_id
        WHERE ${clause}
        ORDER BY ${AUDIT_EVENTS_ALIAS}.created_at DESC, ${AUDIT_EVENTS_ALIAS}.id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, options.limit, options.offset],
    );

    const countQuery = this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events ${AUDIT_EVENTS_ALIAS} WHERE ${clause}`,
      values,
    );

    const [{ rows }, { rows: countRows }] = await Promise.all([listQuery, countQuery]);

    return {
      events: rows.map(toAuditEventWithNames),
      total: Number(countRows[0]?.count ?? 0),
    };
  }
}
