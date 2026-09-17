import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import type { OrganizationRepository } from "../organizations/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { AuditEventRepository } from "./repository.js";
import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  toPublicAuditEvent,
} from "./types.js";

/**
 * ADR 028 items 7-8: the read side of the audit trail. Org-admin only,
 * reusing exactly the gate every other org-admin surface uses
 * (organizations/routes.ts's `role !== "admin"` — cluster, secrets,
 * providers): the capability matrix has no audit capability and adding one
 * would be a new permission concept, which this ADR deliberately avoids.
 *
 * Member-visible own-trail is deferred (ADR 028 item 8), not silently
 * missing: a non-admin gets 403 from this route today.
 */

/**
 * `from`/`to` accept anything `Date.parse` understands — a bare `2026-09-01`
 * from a date input as well as a full ISO timestamp — because the Web app's
 * date fields send the former.
 */
const dateSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "Invalid date");

const listQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(128).optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export function createAuditRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  organizations: OrganizationRepository;
  audit: AuditEventRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  router.get("/:organizationId/audit", requireAuth, async (req, res) => {
    const orgId = routeParam(req.params.organizationId);
    if (!isUuid(orgId)) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    const role = await deps.organizations.roleForUser(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const limit = parsed.data.limit ?? AUDIT_DEFAULT_LIMIT;
    const offset = parsed.data.offset ?? 0;

    const { events, total } = await deps.audit.listForOrganization(orgId, {
      projectId: parsed.data.projectId,
      actorUserId: parsed.data.actorUserId,
      action: parsed.data.action,
      from: parsed.data.from ? new Date(parsed.data.from) : undefined,
      to: parsed.data.to ? new Date(parsed.data.to) : undefined,
      limit,
      offset,
    });

    res.json({
      events: events.map(toPublicAuditEvent),
      total,
      limit,
      offset,
    });
  });

  return router;
}
