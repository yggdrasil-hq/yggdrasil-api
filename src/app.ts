import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import type pg from "pg";
import { createAuthRouter, createSettingsRouter } from "./auth/routes.js";
import { LoginRateLimiter } from "./auth/rate-limit.js";
import { SessionService } from "./auth/sessions.js";
import { FeatureRepository } from "./features/repository.js";
import { createFeaturesInternalRouter } from "./features/internal-routes.js";
import { createGitHubRouter } from "./github/routes.js";
import { createGitHubAppRouter } from "./github/install-routes.js";
import { GithubInstallationRepository } from "./github/installation-repository.js";
import { InstallStateRepository } from "./github/install-state.js";
import { createGitHubWebhookRouter } from "./github/webhook-routes.js";
import { GithubTokenRepository } from "./github/token-repository.js";
import { UserGithubAccessRepository } from "./github/user-github-access-repository.js";
import { OAuthStateRepository } from "./github/oauth.js";
import { JobRepository } from "./jobs/repository.js";
import { JobEventRepository } from "./jobs/events-repository.js";
import { JobMessageRepository } from "./jobs/messages-repository.js";
import { createJobsInternalRouter } from "./jobs/internal-routes.js";
import { NotificationRepository } from "./notifications/repository.js";
import { createNotificationsRouter } from "./notifications/routes.js";
import { ProjectRepository } from "./projects/repository.js";
import { createProjectsRouter } from "./projects/routes.js";
import { createProjectsInternalRouter } from "./projects/internal-routes.js";
import { SecretRepository } from "./secrets/repository.js";
import { createSecretsRouter } from "./secrets/routes.js";
import { createSecretsInternalRouter } from "./secrets/internal-routes.js";
import { TestRepository } from "./tests/repository.js";
import { UserRepository } from "./users/repository.js";

export interface AppDependencies {
  pool: pg.Pool;
}

export function createApp(deps?: AppDependencies): Express {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "yggdrasil-api" });
  });

  if (!deps?.pool) {
    app.use(express.json());
    return app;
  }

  const installations = new GithubInstallationRepository(deps.pool);
  const projects = new ProjectRepository(deps.pool);
  const jobs = new JobRepository(deps.pool);
  app.use("/webhooks", createGitHubWebhookRouter({ installations, projects, jobs }));

  app.use(express.json());

  const users = new UserRepository(deps.pool);
  const sessions = new SessionService(deps.pool);
  const rateLimiter = new LoginRateLimiter(deps.pool);
  const githubTokens = new GithubTokenRepository(deps.pool);
  const userGithubAccess = new UserGithubAccessRepository(deps.pool);
  const oauthStates = new OAuthStateRepository(deps.pool);
  const installStates = new InstallStateRepository(deps.pool);
  const features = new FeatureRepository(deps.pool);
  const tests = new TestRepository(deps.pool);
  const notifications = new NotificationRepository(deps.pool);
  const secrets = new SecretRepository(deps.pool);
  const jobEvents = new JobEventRepository(deps.pool);
  const jobMessages = new JobMessageRepository(deps.pool);

  app.use("/auth", createAuthRouter({ users, sessions, rateLimiter }));
  app.use("/auth", createGitHubRouter({ users, sessions, oauthStates, githubTokens }));
  app.use("/settings", createSettingsRouter({ users, sessions, githubTokens }));
  app.use(
    "/github",
    createGitHubAppRouter({
      users,
      sessions,
      installations,
      installStates,
      githubTokens,
      userGithubAccess,
    }),
  );
  app.use(
    "/projects",
    createProjectsRouter({
      users,
      sessions,
      projects,
      features,
      tests,
      jobs,
      jobEvents,
      jobMessages,
      notifications,
      installations,
    }),
  );
  app.use(
    "/notifications",
    createNotificationsRouter({ users, sessions, notifications }),
  );
  app.use("/projects", createSecretsRouter({ users, sessions, projects, secrets }));
  app.use("/internal", createSecretsInternalRouter({ secrets }));
  app.use("/internal", createProjectsInternalRouter({ projects, installations }));
  app.use("/internal", createFeaturesInternalRouter({ features, projects, installations }));
  app.use("/internal", createJobsInternalRouter({ jobEvents, jobs, features }));

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
