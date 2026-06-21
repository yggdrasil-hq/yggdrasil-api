import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import type { NotificationRepository } from "./repository.js";
import { toPublicNotification } from "./types.js";
import { UserRepository } from "../users/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";

export function createNotificationsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  notifications: NotificationRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  router.get("/", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    const [items, unreadCount] = await Promise.all([
      deps.notifications.listForUser(user.id),
      deps.notifications.unreadCount(user.id),
    ]);

    res.json({
      notifications: items.map(toPublicNotification),
      unreadCount,
    });
  });

  router.patch("/:notificationId/read", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    const notificationId = routeParam(req.params.notificationId);
    if (!isUuid(notificationId)) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    const notification = await deps.notifications.markRead(notificationId, user.id);

    if (!notification) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }

    res.json(toPublicNotification(notification));
  });

  router.post("/read-all", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    await deps.notifications.markAllRead(user.id);
    res.status(204).send();
  });

  return router;
}
