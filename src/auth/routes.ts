import { Router } from "express";
import { z } from "zod";
import { clearSessionCookie } from "./cookies.js";
import { createAuthMiddleware } from "./middleware.js";
import type { SessionService } from "./sessions.js";
import { confirmUsernameSchema } from "./validation.js";
import { UserRepository } from "../users/repository.js";
import { toPublicUser } from "../users/types.js";

function parseBody<T>(schema: z.ZodType<T>, body: unknown):
  | { success: true; data: T }
  | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (!result.success) {
    return { success: false, error: result.error.issues[0]?.message ?? "Invalid input" };
  }
  return { success: true, data: result.data };
}

export function createAuthRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  router.post("/logout", requireAuth, async (req, res) => {
    if (req.sessionId) {
      await deps.sessions.delete(req.sessionId);
    }
    clearSessionCookie(res);
    res.status(204).send();
  });

  router.get("/me", requireAuth, (req, res) => {
    res.json({ user: toPublicUser(req.currentUser!) });
  });

  router.post("/onboarding/confirm-username", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    if (user.onboardingState !== "pending_username") {
      res.status(400).json({ error: "Username already confirmed" });
      return;
    }

    const parsed = parseBody(confirmUsernameSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const { username, displayName } = parsed.data;
    if (username !== user.username && (await deps.users.isUsernameTaken(username))) {
      res.status(409).json({ error: "Username is already taken" });
      return;
    }

    const updated = await deps.users.confirmUsername(user.id, username, displayName);
    if (!updated) {
      res.status(400).json({ error: "Unable to confirm username" });
      return;
    }

    res.json({ user: toPublicUser(updated) });
  });

  return router;
}

export function createSettingsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  router.patch("/account", requireAuth, async (req, res) => {
    const schema = z.object({
      displayName: z.string().trim().min(1).max(128),
    });
    const parsed = parseBody(schema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const updated = await deps.users.updateDisplayName(
      req.currentUser!.id,
      parsed.data.displayName,
    );
    if (!updated) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user: toPublicUser(updated) });
  });

  return router;
}
