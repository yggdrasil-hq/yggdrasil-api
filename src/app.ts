// Issue #45: side-effect import, and it must come first: it patches Express's
// route registration so a rejected promise in an async handler reaches the error
// middleware below instead of hanging the request. Before any router module,
// because the patch has to be in place before a Router is constructed.
import "./shared/async-handlers.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import type pg from "pg";
import { config } from "./config.js";
import { createObjectStorage } from "./storage/client.js";
import { AuditEventRepository } from "./audit/repository.js";
import { PostgresAuditRecorder } from "./audit/record.js";
import { auditContextMiddleware } from "./audit/request-context.js";
import { createAuditRouter } from "./audit/routes.js";
import { ProjectDeployRepository } from "./deploys/repository.js";
import { createDeploysInternalRouter } from "./deploys/internal-routes.js";
import { JobPreviewRepository } from "./previews/repository.js";
import { createPreviewsInternalRouter } from "./previews/internal-routes.js";
import { createPreviewsRouter } from "./previews/routes.js";
import { createAuthRouter, createSettingsRouter } from "./auth/routes.js";
import { SessionService } from "./auth/sessions.js";
import { FeatureRepository } from "./features/repository.js";
import { FeatureActionItemRepository } from "./features/action-items-repository.js";
import { createFeaturesInternalRouter } from "./features/internal-routes.js";
import { createDesignsInternalRouter } from "./designs/internal-routes.js";
import { createDesignsRouter } from "./designs/routes.js";
import { DesignRepository } from "./designs/repository.js";
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
import { createNotificationPreferencesRouter } from "./notifications/preferences-routes.js";
import { NotificationPreferencesRepository } from "./notifications/preferences-repository.js";
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
import { OrgExtensionRepository } from "./extensions/repository.js";
import { createOrgExtensionsRouter } from "./extensions/routes.js";
import { createExtensionsInternalRouter } from "./extensions/internal-routes.js";
import { createOrganizationsInternalRouter } from "./organizations/internal-routes.js";
import { OrgProviderRepository } from "./model-config/provider-repository.js";
import { OrgModelRepository } from "./model-config/model-repository.js";
import { JobModelDefaultRepository } from "./model-config/job-default-repository.js";
import { ProjectModelOverrideRepository } from "./model-config/project-override-repository.js";
import { FeatureJobModelOverrideRepository } from "./model-config/feature-override-repository.js";
import { JobUsageRepository } from "./usage/repository.js";
import {
  createOrganizationUsageRouter,
  createProjectUsageRouter,
} from "./usage/routes.js";
import { AllocationRepository } from "./allocations/repository.js";
import { createAllocationsRouter } from "./allocations/routes.js";
import { createAllocationsInternalRouter } from "./allocations/internal-routes.js";
import { createModelConfigRouter } from "./model-config/routes.js";
import { createProjectModelOverridesRouter } from "./model-config/project-routes.js";
import { createFeatureModelConfigRouter } from "./model-config/feature-routes.js";
import { FeatureModelSecretRepository } from "./secrets/feature-model-repository.js";
import { TestRepository } from "./tests/repository.js";
import { TestRunReportRepository } from "./tests/reports-repository.js";
import { JobRecordingRepository } from "./recordings/repository.js";
import { createRecordingsRouter } from "./recordings/routes.js";
import { createRecordingsInternalRouter } from "./recordings/internal-routes.js";
import { JobScreenshotRepository } from "./screenshots/repository.js";
import { createScreenshotsRouter } from "./screenshots/routes.js";
import { createScreenshotsInternalRouter } from "./screenshots/internal-routes.js";
import { UserRepository } from "./users/repository.js";
import { NOOP_LIVE_PUBLISHER, type LivePublisher } from "./live/deltas.js";

export interface AppDependencies {
  pool: pg.Pool;
  /**
   * ADR 019 item 13's streaming-delta relay. Omitted by every test (they build an
   * app without a socket server or a listener), in which case a delta is
   * accepted and dropped — the same outcome as a deployment with the relay
   * switched off. `index.ts` is the only caller that passes a real one.
   */
  live?: LivePublisher;
}

export function createApp(deps?: AppDependencies): Express {
  const app = express();
  app.set("trust proxy", 1);
  // Web calls the API with credentials: "include" (cookie session auth), so
  // the origin must be an explicit allow-list entry, not "*" — browsers
  // reject Access-Control-Allow-Origin: "*" alongside credentialed requests.
  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(cookieParser());
  // ADR 028: captures ip/user-agent for the audit trail before any router
  // runs. App-wide (not per-router) because both authenticated routes and
  // the GitHub webhook router record events.
  app.use(auditContextMiddleware);

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
  const auditEvents = new AuditEventRepository(deps.pool);
  const audit = new PostgresAuditRecorder(auditEvents);
  const deploys = new ProjectDeployRepository(deps.pool);
  const previews = new JobPreviewRepository(deps.pool);
  // Issue #30: whether artifacts go to object storage is decided once, from
  // the configuration, and handed to every repository that stores bytes. Null
  // when no bucket is configured, which is what makes this change additive — the
  // repositories fall back to their previous Postgres columns, so an install
  // that has not been given a bucket behaves exactly as it did before.
  const objectStorage = createObjectStorage(config.storage.configured ? config.storage : null);
  const recordings = new JobRecordingRepository(deps.pool, objectStorage);
  const screenshots = new JobScreenshotRepository(deps.pool, objectStorage);
  app.use(
    "/webhooks",
    createGitHubWebhookRouter({
      installations,
      projects,
      jobs,
      features,
      actionItems: featureActionItems,
      audit,
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
  const designs = new DesignRepository(deps.pool);
  const jobEvents = new JobEventRepository(deps.pool);
  const jobMessages = new JobMessageRepository(deps.pool);
  const organizations = new OrganizationRepository(deps.pool);
  const orgClusters = new OrganizationClusterRepository(deps.pool);
  const modelProviders = new OrgProviderRepository(deps.pool);
  const orgModels = new OrgModelRepository(deps.pool);
  const jobModelDefaults = new JobModelDefaultRepository(deps.pool);
  const projectModelOverrides = new ProjectModelOverrideRepository(deps.pool);
  const featureModelOverrides = new FeatureJobModelOverrideRepository(deps.pool);
  const featureModelSecrets = new FeatureModelSecretRepository(deps.pool);
  const jobUsage = new JobUsageRepository(deps.pool);
  const orgExtensions = new OrgExtensionRepository(deps.pool, objectStorage);
  const allocations = new AllocationRepository(deps.pool);

  app.use("/auth", createAuthRouter({ users, sessions }));
  app.use(
    "/auth",
    createGitHubRouter({ users, sessions, oauthStates, githubTokens, organizations }),
  );
  app.use("/settings", createSettingsRouter({ users, sessions }));
  app.use(
    "/organizations",
    createOrganizationsRouter({ users, sessions, organizations, clusters: orgClusters, orgSecrets, audit }),
  );
  app.use(
    "/organizations",
    createAuditRouter({ users, sessions, organizations, audit: auditEvents }),
  );
  // ADR 023: token/cost consumption reporting, org- and project-scoped reads.
  //
  // Two routers, one per scope, each registered with relative paths — the shape
  // every other router here uses (issue #56). This previously mounted a *single*
  // router which carried its own full paths at both prefixes, so Express joined
  // the prefix onto an already-absolute path: every documented endpoint was
  // served at a doubled path and all four 404'd in a real deployment. The
  // comment above the old wiring described that arrangement as deliberate, which
  // is what made it invisible.
  //
  // The wiring itself is now asserted by `src/app.routing.test.ts`, because the
  // route-level tests mounted this router at root and therefore could not see
  // the mismatch.
  const usageDeps = { users, sessions, organizations, projects, usage: jobUsage };
  app.use("/organizations", createOrganizationUsageRouter(usageDeps));
  app.use("/projects", createProjectUsageRouter(usageDeps));
  app.use(
    "/organizations",
    createModelConfigRouter({
      users,
      sessions,
      organizations,
      providers: modelProviders,
      models: orgModels,
      jobDefaults: jobModelDefaults,
      audit,
    }),
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
      projects,
      audit,
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
      providers: modelProviders,
      models: orgModels,
      jobDefaults: jobModelDefaults,
      projectOverrides: projectModelOverrides,
      featureOverrides: featureModelOverrides,
      featureSecrets: featureModelSecrets,
      designs,
      deploys,
      audit,
    }),
  );
  app.use(
    "/settings",
    createNotificationPreferencesRouter({
      users,
      sessions,
      organizations,
      projects,
      preferences: new NotificationPreferencesRepository(deps.pool),
    }),
  );
  app.use(
    "/notifications",
    createNotificationsRouter({ users, sessions, notifications }),
  );
  app.use(
    "/projects",
    createSecretsRouter({ users, sessions, projects, secrets, orgSecrets, audit }),
  );
  app.use(
    "/projects",
    createProjectModelOverridesRouter({
      users,
      sessions,
      projects,
      models: orgModels,
      projectOverrides: projectModelOverrides,
      audit,
    }),
  );
  // ADR 018 amendment (issue #5): the per-feature model-config tier, same
  // `/projects` mount as the project tier it mirrors.
  app.use(
    "/projects",
    createFeatureModelConfigRouter({
      users,
      sessions,
      projects,
      features,
      models: orgModels,
      featureOverrides: featureModelOverrides,
      featureSecrets: featureModelSecrets,
      resolution: {
        secrets,
        providers: modelProviders,
        models: orgModels,
        jobDefaults: jobModelDefaults,
        projectOverrides: projectModelOverrides,
      },
    }),
  );
  app.use(
    "/internal",
    createSecretsInternalRouter({
      secrets,
      projects,
      features,
      providers: modelProviders,
      models: orgModels,
      jobDefaults: jobModelDefaults,
      projectOverrides: projectModelOverrides,
      featureOverrides: featureModelOverrides,
      featureSecrets: featureModelSecrets,
    }),
  );
  app.use(
    "/internal",
    createDesignsInternalRouter({ jobs, projects, installations, designs }),
  );
  // ADR 020 item 6: read-only design browse/history. Same `/projects` mount as
  // the project/feature routers; it shares no param-shaped route with them.
  app.use("/projects", createDesignsRouter({ users, sessions, projects, designs }));
  app.use(
    "/internal",
    createDeploysInternalRouter({ deploys, jobs }),
  );
  // ADR 003 §15: the Orchestrator's preview registry — register/teardown, plus
  // the stale list the orphan sweep works from.
  // ADR 025: uploaded Pi extensions -- org-admin CRUD, plus the bundle the
  // Orchestrator fetches at dispatch time for a project that opted in.
  app.use(
    "/organizations",
    createOrgExtensionsRouter({ users, sessions, organizations, extensions: orgExtensions, audit }),
  );
  app.use(
    "/internal",
    createExtensionsInternalRouter({ projects, extensions: orgExtensions }),
  );
  app.use(
    "/internal",
    createPreviewsInternalRouter({ previews, jobs }),
  );
  // ADR 030: the org-admin cap surface. Same `/organizations` mount as the
  // audit trail — `/allocations` is a literal segment, so it cannot be
  // swallowed by a param route on either router.
  app.use(
    "/organizations",
    createAllocationsRouter({ users, sessions, organizations, projects, allocations, audit }),
  );
  // ADR 003 §15: a project's previews, read-only. Same `/projects` mount as
  // the designs/deploys routers; no shared param-shaped route.
  app.use("/projects", createPreviewsRouter({ users, sessions, projects, previews }));
  // ADR 029: a job's screen recording and its metadata, read behind the
  // ordinary session cookie (deliberately not public, unlike previews — see
  // recordings/routes.ts). Same `/projects` mount; the path is `jobs/:jobId`,
  // which no sibling router claims.
  app.use(
    "/projects",
    createRecordingsRouter({ users, sessions, projects, jobs, recordings }),
  );

  // Issue #22: a run's screenshots, behind the same project-access gate as its
  // recording — a screenshot of a real session can show real customer data, so
  // it is not served from a public URL. Same `/projects` mount and path shape as
  // the recordings router above.
  app.use(
    "/projects",
    createScreenshotsRouter({ users, sessions, projects, jobs, screenshots }),
  );
  app.use(
    "/internal",
    createOrganizationsInternalRouter({ projects, clusters: orgClusters }),
  );
  app.use("/internal", createProjectsInternalRouter({ projects, installations }));
  // ADR 029: the Orchestrator uploads a job's recording here before the pod is
  // deleted. Binary body, so the route carries its own `express.raw` parser.
  app.use(
    "/internal",
    createRecordingsInternalRouter({ jobs, recordings }),
  );

  app.use(
    "/internal",
    createScreenshotsInternalRouter({ jobs, screenshots }),
  );
  app.use("/internal", createAllocationsInternalRouter({ projects, allocations }));
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
      designs,
      usage: jobUsage,
      live: deps.live ?? NOOP_LIVE_PUBLISHER,
      modelConfig: {
        secrets,
        featureSecrets: featureModelSecrets,
        providers: modelProviders,
        models: orgModels,
        jobDefaults: jobModelDefaults,
        projectOverrides: projectModelOverrides,
        featureOverrides: featureModelOverrides,
      },
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
