import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import type pg from "pg";
import { config } from "./config.js";
import { createAuthRouter, createSettingsRouter } from "./auth/routes.js";
import { SessionService } from "./auth/sessions.js";
import { FeatureRepository } from "./features/repository.js";
import { FeatureActionItemRepository } from "./features/action-items-repository.js";
import { createFeaturesInternalRouter } from "./features/internal-routes.js";
import { createDesignsInternalRouter } from "./designs/internal-routes.js";
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
import { OrgSecretRepository } from "./organizations/org-secrets-repository.js";
import { OrganizationRepository } from "./organizations/repository.js";
import { OrganizationClusterRepository } from "./organizations/cluster-repository.js";
import { createOrganizationsRouter } from "./organizations/routes.js";
import { createOrganizationsInternalRouter } from "./organizations/internal-routes.js";
import { TestRepository } from "./tests/repository.js";
import { TestRunReportRepository } from "./tests/reports-repository.js";
import { UserRepository } from "./users/repository.js";

export interface AppDependencies {
  pool: pg.Pool;
}

export function createApp(deps?: AppDependencies): Express {
  const app = express();
  app.set("trust proxy", 1);
  // Web calls the API with credentials: "include" (cookie session auth), so
  // the origin must be an explicit allow-list entry, not "*" — browsers
  // reject Access-Control-Allow-Origin: "*" alongside credentialed requests.
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "yggdrasil-api" });
  });

  if (!deps?.pool) {
    app.use(express.json({ limit: "2mb" }));
    return app;
  }

  const installations = new GithubInstallationRepository(deps.pool);
  const projects = new ProjectRepository(deps.pool);
  const jobs = new JobRepository(deps.pool);
  const features = new FeatureRepository(deps.pool);
  const featureActionItems = new FeatureActionItemRepository(deps.pool);
  app.use(
    "/webhooks",
    createGitHubWebhookRouter({
      installations,
      projects,
      jobs,
      features,
      actionItems: featureActionItems,
    }),
  );

  app.use(express.json({ limit: "2mb" }));

  const users = new UserRepository(deps.pool);
  const sessions = new SessionService(deps.pool);
  const githubTokens = new GithubTokenRepository(deps.pool);
  const userGithubAccess = new UserGithubAccessRepository(deps.pool);
  const oauthStates = new OAuthStateRepository(deps.pool);
  const installStates = new InstallStateRepository(deps.pool);
  const tests = new TestRepository(deps.pool);
  const testRunReports = new TestRunReportRepository(deps.pool);
  const notifications = new NotificationRepository(deps.pool);
  const secrets = new SecretRepository(deps.pool);
  const orgSecrets = new OrgSecretRepository(deps.pool);
  const jobEvents = new JobEventRepository(deps.pool);
  const jobMessages = new JobMessageRepository(deps.pool);
  const organizations = new OrganizationRepository(deps.pool);
  const orgClusters = new OrganizationClusterRepository(deps.pool);

  app.use("/auth", createAuthRouter({ users, sessions }));
  app.use(
    "/auth",
    createGitHubRouter({ users, sessions, oauthStates, githubTokens, organizations }),
  );
  app.use("/settings", createSettingsRouter({ users, sessions }));
  app.use(
    "/organizations",
    createOrganizationsRouter({ users, sessions, organizations, clusters: orgClusters, orgSecrets }),
  );
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
      actionItems: featureActionItems,
      tests,
      testRunReports,
      jobs,
      jobEvents,
      jobMessages,
      notifications,
      installations,
      secrets,
      orgSecrets,
      organizations,
    }),
  );
  app.use(
    "/notifications",
    createNotificationsRouter({ users, sessions, notifications }),
  );
  app.use(
    "/projects",
    createSecretsRouter({ users, sessions, projects, secrets, orgSecrets }),
  );
  app.use("/internal", createSecretsInternalRouter({ secrets, orgSecrets, projects }));
  app.use(
    "/internal",
    createDesignsInternalRouter({ jobs, projects, installations }),
  );
  app.use(
    "/internal",
    createOrganizationsInternalRouter({ projects, clusters: orgClusters }),
  );
  app.use("/internal", createProjectsInternalRouter({ projects, installations }));
  app.use(
    "/internal",
    createFeaturesInternalRouter({ features, projects, installations, tests, jobs }),
  );
  app.use(
    "/internal",
    createJobsInternalRouter({
      jobEvents,
      jobs,
      features,
      actionItems: featureActionItems,
      tests,
      testRunReports,
      projects,
    }),
  );

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return app;
}
