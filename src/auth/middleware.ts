import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import type { SessionService } from "./sessions.js";
import { UserRepository } from "../users/repository.js";
import type { User } from "../users/types.js";

declare global {
  namespace Express {
    interface Request {
      currentUser?: User;
      sessionId?: string;
    }
  }
}

export function createAuthMiddleware(
  sessions: SessionService,
  users: UserRepository,
) {
  return async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const sessionId = req.cookies?.[config.cookieName];
    if (!sessionId || typeof sessionId !== "string") {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const session = await sessions.findValid(sessionId);
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const user = await users.findById(session.userId);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await sessions.touch(session);
    req.currentUser = user;
    req.sessionId = session.id;
    next();
  };
}

export function optionalAuth(
  sessions: SessionService,
  users: UserRepository,
) {
  return async function optionalAuthMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const sessionId = req.cookies?.[config.cookieName];
    if (!sessionId || typeof sessionId !== "string") {
      next();
      return;
    }

    const session = await sessions.findValid(sessionId);
    if (!session) {
      next();
      return;
    }

    const user = await users.findById(session.userId);
    if (!user) {
      next();
      return;
    }

    await sessions.touch(session);
    req.currentUser = user;
    req.sessionId = session.id;
    next();
  };
}
