import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import type pg from "pg";
import { createAuthRouter, createSettingsRouter } from "./auth/routes.js";
import { LoginRateLimiter } from "./auth/rate-limit.js";
import { SessionService } from "./auth/sessions.js";
import { createGitHubRouter } from "./github/routes.js";
import { GithubTokenRepository } from "./github/token-repository.js";
import { OAuthStateRepository } from "./github/oauth.js";
import { UserRepository } from "./users/repository.js";

export interface AppDependencies {
  pool: pg.Pool;
}

export function createApp(deps?: AppDependencies): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "yggdrasil-api" });
  });

  if (!deps?.pool) {
    return app;
  }

  const users = new UserRepository(deps.pool);
  const sessions = new SessionService(deps.pool);
  const rateLimiter = new LoginRateLimiter(deps.pool);
  const githubTokens = new GithubTokenRepository(deps.pool);
  const oauthStates = new OAuthStateRepository(deps.pool);

  app.use("/auth", createAuthRouter({ users, sessions, rateLimiter }));
  app.use("/auth", createGitHubRouter({ users, sessions, oauthStates, githubTokens }));
  app.use("/settings", createSettingsRouter({ users, sessions, githubTokens }));

  return app;
}
