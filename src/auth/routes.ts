import { Router } from "express";
import { z } from "zod";
import { clearSessionCookie, setSessionCookie } from "./cookies.js";
import { createAuthMiddleware } from "./middleware.js";
import { hashPassword, verifyPassword } from "./password.js";
import { getClientIp, LoginRateLimiter } from "./rate-limit.js";
import type { SessionService } from "./sessions.js";
import {
  confirmUsernameSchema,
  loginSchema,
  signupSchema,
} from "./validation.js";
import { UserRepository } from "../users/repository.js";
import { toPublicUser } from "../users/types.js";
import { config } from "../config.js";

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
  rateLimiter: LoginRateLimiter;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  router.post("/signup", async (req, res) => {
    const parsed = parseBody(signupSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const { username, password, displayName } = parsed.data;
    if (await deps.users.isUsernameTaken(username)) {
      res.status(409).json({ error: "Username is already taken" });
      return;
    }

    const passwordHash = await hashPassword(password);
    const user = await deps.users.createPasswordUser({
      username,
      displayName: displayName ?? username,
      passwordHash,
    });

    const session = await deps.sessions.create(user, false);
    setSessionCookie(res, session.id, false);
    res.status(201).json({ user: toPublicUser(user) });
  });

  router.post("/login", async (req, res) => {
    const parsed = parseBody(loginSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const { username, password, rememberMe } = parsed.data;
    const ip = getClientIp(req);

    if (await deps.rateLimiter.isBlocked(username, ip)) {
      res.status(429).json({ error: "Too many login attempts. Try again later." });
      return;
    }

    const user = await deps.users.findByUsername(username);
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      await deps.rateLimiter.recordFailure(username, ip);
      res.status(401).json({ error: "Invalid username or password" });
      return;
    }

    const session = await deps.sessions.create(user, rememberMe);
    setSessionCookie(res, session.id, rememberMe);
    res.json({ user: toPublicUser(user) });
  });

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
  githubTokens: import("../github/token-repository.js").GithubTokenRepository;
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

  router.post("/password", requireAuth, async (req, res) => {
    const schema = z.object({
      currentPassword: z.string().optional(),
      newPassword: z.string().min(8),
    });
    const parsed = parseBody(schema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const user = req.currentUser!;
    const { currentPassword, newPassword } = parsed.data;

    if (user.passwordHash) {
      if (!currentPassword || !(await verifyPassword(currentPassword, user.passwordHash))) {
        res.status(401).json({ error: "Current password is incorrect" });
        return;
      }
    }

    const passwordHash = await hashPassword(newPassword);
    await deps.users.updatePasswordHash(user.id, passwordHash);
    await deps.sessions.deleteAllForUserExcept(user.id, req.sessionId);
    res.json({ ok: true });
  });

  router.delete("/github", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    if (!user.passwordHash) {
      res.status(400).json({
        error: "Set a password before disconnecting GitHub",
      });
      return;
    }

    if (!user.githubId) {
      res.status(400).json({ error: "GitHub is not connected" });
      return;
    }

    await deps.githubTokens.delete(user.id);
    const updated = await deps.users.unlinkGithub(user.id);
    res.json({ user: toPublicUser(updated!) });
  });

  return router;
}
