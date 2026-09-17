import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import type { OrganizationRepository } from "../organizations/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { UserRepository } from "../users/repository.js";
import { isUuid } from "../shared/uuid.js";
import { routeParam } from "../shared/route-param.js";
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_KIND_DESCRIPTIONS,
  NOTIFICATION_KIND_LABELS,
  isKindEnabled,
  isKnownNotificationKind,
  type NotificationPreference,
} from "./preferences.js";
import type { NotificationPreferencesRepository } from "./preferences-repository.js";

/**
 * A user's own notification preferences (ADR 027).
 *
 * Mounted under `/settings` beside the existing account routes because these
 * are personal settings, not organization configuration: any member may read
 * and write their own, and no role is required. Membership of the organization
 * being configured is required, and a non-member gets the same 404 the
 * neighbouring `/organizations/:id` route returns — a 403 there would confirm
 * the organization exists.
 *
 * Note the scope: the *preferences* are per-user, the *organization* is the
 * axis they are keyed by (kinds are muted per org, because the kinds a user
 * cares about are org-relative and a user can belong to several).
 */
export function createNotificationPreferencesRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  organizations: OrganizationRepository;
  projects: ProjectRepository;
  preferences: NotificationPreferencesRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  const setPreferenceSchema = z.object({
    organizationId: z.string(),
    // null is the org-wide master row, so it must be allowed through.
    kind: z.string().nullable(),
    enabled: z.boolean(),
  });

  const setProjectMuteSchema = z.object({
    muted: z.boolean(),
  });

  function toPublicPreference(kind: string | null, enabled: boolean) {
    if (kind === null) {
      return {
        kind: null,
        label: "All project activity",
        description: "Every kind below, for this organization.",
        enabled,
      };
    }
    return {
      kind,
      // An unknown kind can only come from a row written before the kind was
      // removed from the registry; showing its raw value beats showing nothing.
      label: isKnownNotificationKind(kind) ? NOTIFICATION_KIND_LABELS[kind] : kind,
      description: isKnownNotificationKind(kind)
        ? NOTIFICATION_KIND_DESCRIPTIONS[kind]
        : null,
      enabled,
    };
  }

  router.get("/notification-preferences", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    const organizationId = req.query.org;

    if (typeof organizationId !== "string" || !isUuid(organizationId)) {
      res.status(400).json({ error: "A valid organization id is required" });
      return;
    }

    const role = await deps.organizations.roleForUser(organizationId, user.id);
    if (!role) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    const [preferences, mutedProjectIds] = await Promise.all([
      deps.preferences.listForUserOrganization(user.id, organizationId),
      deps.preferences.listMutedProjectIds(user.id),
    ]);

    res.json({
      organizationId,
      // The master row first, then every known kind with its *effective* state
      // (a concrete row if one exists, else the master row, else the default),
      // so the UI never has to re-derive precedence.
      preferences: [
        toPublicPreference(null, masterEnabled(preferences)),
        ...NOTIFICATION_KINDS.map((kind) =>
          toPublicPreference(kind, isKindEnabled(kind, preferences)),
        ),
      ],
      mutedProjectIds,
    });
  });

  router.put("/notification-preferences", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    const parsed = setPreferenceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const { organizationId, kind, enabled } = parsed.data;
    if (!isUuid(organizationId)) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    if (kind !== null && !isKnownNotificationKind(kind)) {
      res.status(400).json({ error: "Unknown notification kind" });
      return;
    }

    const role = await deps.organizations.roleForUser(organizationId, user.id);
    if (!role) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    const saved = await deps.preferences.setPreference({
      userId: user.id,
      organizationId,
      kind,
      enabled,
    });
    res.json(toPublicPreference(saved.kind, saved.enabled));
  });

  router.put(
    "/notification-preferences/projects/:projectId",
    requireAuth,
    async (req, res) => {
      const user = req.currentUser!;
      const projectId = routeParam(req.params.projectId);
      const parsed = setProjectMuteSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
        return;
      }
      if (!isUuid(projectId)) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      // Same access gate the project's own settings routes use, so a user can
      // only mute a project they can already see.
      const project = await deps.projects.findByIdForUser(projectId, user.id);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      await deps.preferences.setProjectMute(user.id, projectId, parsed.data.muted);
      res.json({ projectId, muted: parsed.data.muted });
    },
  );

  return router;
}

/**
 * The stored org-wide row's own state, shown on the master toggle's line. This
 * is deliberately not `isKindEnabled` for any particular kind: it is what the
 * user set for the organization, which is what the master switch should show.
 */
function masterEnabled(
  preferences: Pick<NotificationPreference, "kind" | "enabled">[],
): boolean {
  const master = preferences.find((row) => row.kind === null);
  return master ? master.enabled : true;
}
