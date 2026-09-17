import type { Response } from "express";
import type { AuditActionName } from "./actions.js";
import { auditContextFrom } from "./request-context.js";
import type { AuditEventRepository } from "./repository.js";
import type { AuditActorKind } from "./types.js";

/**
 * One mutation to record. `organizationId` is the tenancy scope (ADR 016
 * item 4) and is required — an event with no org has nowhere to be read from.
 *
 * `metadata` is structured context for humans reading the trail later: names,
 * slugs, job kinds, before/after values that aren't sensitive. It must NEVER
 * carry secret plaintext, an API key, or a kubeconfig — the trail is
 * broadly readable by org admins and is kept forever.
 */
export interface RecordAuditInput {
  organizationId: string;
  projectId?: string | null;
  actorUserId?: string | null;
  actorKind?: AuditActorKind;
  action: AuditActionName;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * What route handlers actually depend on. The repository sits behind this
 * interface so tests can pass a fake recorder, exactly as they fake the other
 * repositories.
 */
export interface AuditRecorder {
  record(res: Response, input: RecordAuditInput): Promise<void>;
}

/** Reserved metadata key for the captured User-Agent (see below). */
export const AUDIT_USER_AGENT_KEY = "actorUserAgent";

function withActorUserAgent(
  metadata: Record<string, unknown> | undefined,
  userAgent: string | null,
): Record<string, unknown> {
  if (!userAgent) return metadata ?? {};
  return { ...(metadata ?? {}), [AUDIT_USER_AGENT_KEY]: userAgent };
}

/**
 * ADR 028 item 5: `recordAudit` is called from inside the mutation sites
 * themselves — it sees the domain-meaningful action name and target id that a
 * blanket express middleware over "all mutating routes" could not derive.
 *
 * An audit write must never fail the request that produced it: the mutation
 * has already happened, and turning a successful mutation into a 500 because
 * the trail failed to write would be strictly worse than a gap in the trail.
 * Failures are logged and swallowed. The trade-off is explicit and recorded in
 * ADR 028 — a trail that can silently drop entries is weaker than one backed
 * by an outbox/transaction, which is deferred (see the ADR's Follow-ups).
 */
export class PostgresAuditRecorder implements AuditRecorder {
  constructor(private readonly repository: AuditEventRepository) {}

  async record(res: Response, input: RecordAuditInput): Promise<void> {
    try {
      const context = auditContextFrom(res);
      await this.repository.create({
        organizationId: input.organizationId,
        projectId: input.projectId ?? null,
        actorUserId: input.actorUserId ?? null,
        actorKind: input.actorKind ?? "user",
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        // ADR 028's decided table shape has an `ip` column but no user_agent
        // column, so the other half of what the request-context middleware
        // captures rides along in metadata under a reserved key rather than
        // being captured and dropped.
        metadata: withActorUserAgent(input.metadata, context.userAgent),
        ip: context.ip,
      });
    } catch (error) {
      console.error(
        `audit: failed to record ${input.action} for organization ${input.organizationId}:`,
        error,
      );
    }
  }
}
