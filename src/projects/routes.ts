import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { dispatchDeployJob, dispatchJob } from "../jobs/dispatch.js";
import type { JobRepository } from "../jobs/repository.js";
import {
  buildGrillRestartSeed,
  canRestartFromMessage,
  messageRestartRefusal,
  MESSAGE_RESTART_STATUSES,
} from "../jobs/grill-context.js";
import type { JobEventRepository } from "../jobs/events-repository.js";
import type { JobMessageRepository } from "../jobs/messages-repository.js";
import type { NotificationRepository } from "../notifications/repository.js";
import { UserRepository } from "../users/repository.js";
import type { FeatureRepository } from "../features/repository.js";
import type { FeatureActionItemRepository } from "../features/action-items-repository.js";
import { toPublicActionItem } from "../features/action-items-types.js";
import { toPublicFeature } from "../features/types.js";
import type { TestRepository } from "../tests/repository.js";
import type { TestRunReportRepository } from "../tests/reports-repository.js";
import { toPublicTestRunExecution } from "../tests/report-types.js";
import { toPublicTestRunHistoryEntry } from "../tests/run-history.js";
import { toPublicAgenticReview } from "../features/review-types.js";
import { deriveAwaitingReply } from "../jobs/grill-wait.js";
import { earlierGrillRuns } from "../jobs/grill-runs.js";
import { isValidTimeZone } from "../scheduling/timezone.js";
import {
  isValidCronExpression,
  meetsMinimumInterval,
  toPublicTest,
} from "../tests/types.js";
import { buildProjectOverview } from "./overview.js";
import { scaffoldChart } from "./chart-scaffold.js";
import type { ProjectRepository } from "./repository.js";
import {
  getRepositoryRemovalBlockedReason,
  getProjectDeletionBlocker,
} from "./repository-removal.js";
import { toPublicProject } from "./types.js";
import type { Project } from "./types.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import { slugify } from "../shared/slug.js";
import type { GithubInstallationRepository } from "../github/installation-repository.js";
import { MODEL_CONFIG_KEYS, resolveModelConfigForJob, resolveOrgModelConfig } from "../secrets/model-config.js";
import type { ModelConfigBundle, ModelConfigResolutionDeps } from "../secrets/model-config.js";
import type { SecretRepository } from "../secrets/repository.js";
import type { OrgSecretRepository } from "../organizations/org-secrets-repository.js";
import type { OrganizationRepository } from "../organizations/repository.js";
import type { OrgProviderRepository } from "../model-config/provider-repository.js";
import type { OrgModelRepository } from "../model-config/model-repository.js";
import type { JobModelDefaultRepository } from "../model-config/job-default-repository.js";
import type { ProjectModelOverrideRepository } from "../model-config/project-override-repository.js";
import type { FeatureJobModelOverrideRepository } from "../model-config/feature-override-repository.js";
import type { FeatureModelSecretRepository } from "../secrets/feature-model-repository.js";
import type { AgentJobKind } from "../model-config/types.js";
import { describeMissingModelKinds, evaluateModelCoverage } from "../organizations/readiness.js";
import { AUDIT_ACTIONS } from "../audit/actions.js";
import type { AuditRecorder } from "../audit/record.js";
import type { DesignRepository } from "../designs/repository.js";
import type { ProjectDeployRepository } from "../deploys/repository.js";
import { toPublicProjectDeploy } from "../deploys/types.js";

function parseBody<T>(schema: z.ZodType<T>, body: unknown):
  | { success: true; data: T }
  | { success: false; error: string } {
  const result = schema.safeParse(body);
  if (!result.success) {
    return { success: false, error: result.error.issues[0]?.message ?? "Invalid input" };
  }
  return { success: true, data: result.data };
}

const repositorySchema = z.object({
  githubOwner: z.string().min(1),
  githubRepo: z.string().min(1),
  isPrimary: z.boolean(),
});

const modelConfigBundleSchema = z.object({
  modelBaseUrl: z.string().trim().min(1),
  modelApiKey: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
});

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2000).optional().default(""),
  installationId: z.string().uuid(),
  // The org to create the project under (ADR 016 items 4 & 6). Optional in
  // the API so existing clients work; defaults to the caller's personal org.
  // A5's org switcher will pass the active org explicitly.
  organizationId: z.string().uuid().optional(),
  repositories: z.array(repositorySchema).min(1),
  modelConfig: modelConfigBundleSchema.optional(),
  saveModelConfigAsDefault: z.boolean().optional().default(false),
}).superRefine((value, ctx) => {
  const primaryCount = value.repositories.filter((repo) => repo.isPrimary).length;
  if (primaryCount !== 1) {
    ctx.addIssue({
      code: "custom",
      message: "Exactly one repository must be marked as primary",
      path: ["repositories"],
    });
  }
});

function toModelConfigBundle(input: z.infer<typeof modelConfigBundleSchema>): ModelConfigBundle {
  return {
    MODEL_BASE_URL: input.modelBaseUrl,
    MODEL_API_KEY: input.modelApiKey,
    MODEL_ID: input.modelId,
  };
}

/**
 * A project's always-on primary deployment URL (ADR 003 §15's
 * `<project-slug>.apps.<domain>` scheme). `config.appsHttpsPort` is only
 * ever set in local dev, where the bundled k3s cluster's ingress is
 * published on a non-standard host port instead of real 443 — see
 * `docs/conventions/deploy.md`.
 */
function buildDeployUrl(slug: string): string {
  const port = config.appsHttpsPort ? `:${config.appsHttpsPort}` : "";
  return `https://${slug}.apps.${config.appsBaseDomain}${port}`;
}

const createFeatureSchema = z.object({
  title: z.string().trim().min(1).max(256),
});

const updateFeatureSchema = z.object({
  adrMarkdown: z.string().optional(),
  approveAdr: z.boolean().optional(),
  startBuild: z.boolean().optional(),
});

const createFeatureMessageSchema = z.object({
  content: z.string().trim().min(1).max(8000),
});

const restartFromMessageSchema = z.object({
  eventId: z.string().uuid(),
});

const createDesignSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(4000),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(96).optional(),
  featureId: z.string().uuid().optional(),
  actionItemId: z.string().uuid().optional(),
});

const createTestSchema = z.object({
  name: z.string().trim().min(1).max(256),
  specMarkdown: z.string().min(1),
  scheduleCron: z.string().min(1),
  enabled: z.boolean().optional(),
});

const updateTestSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  specMarkdown: z.string().min(1).optional(),
  scheduleCron: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

/**
 * ADR 026: page size for a test's run history. Mirrors the audit trail's
 * convention (default 50, capped at 200) so one read surface cannot be asked
 * for an unbounded number of rows. A malformed value falls back to the default
 * rather than erroring: this is a display hint, and a bad query string should
 * not turn a readable page into a 400.
 */
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

function historyLimit(raw: unknown): number {
  const parsed = Number(typeof raw === "string" ? raw : HISTORY_DEFAULT_LIMIT);
  if (!Number.isInteger(parsed) || parsed < 1) return HISTORY_DEFAULT_LIMIT;
  return Math.min(parsed, HISTORY_MAX_LIMIT);
}

const addSubRepositorySchema = z.object({
  githubOwner: z.string().trim().min(1),
  githubRepo: z.string().trim().min(1),
});

export function createProjectsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  features: FeatureRepository;
  actionItems: FeatureActionItemRepository;
  tests: TestRepository;
  testRunReports: TestRunReportRepository;
  jobs: JobRepository;
  jobEvents: JobEventRepository;
  jobMessages: JobMessageRepository;
  notifications: NotificationRepository;
  installations: GithubInstallationRepository;
  secrets: SecretRepository;
  orgSecrets: OrgSecretRepository;
  organizations: OrganizationRepository;
  providers: OrgProviderRepository;
  models: OrgModelRepository;
  jobDefaults: JobModelDefaultRepository;
  projectOverrides: ProjectModelOverrideRepository;
  featureOverrides: FeatureJobModelOverrideRepository;
  featureSecrets: FeatureModelSecretRepository;
  designs: DesignRepository;
  deploys: ProjectDeployRepository;
  audit: AuditRecorder;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  const modelConfigDeps = (): ModelConfigResolutionDeps => ({
    secrets: deps.secrets,
    featureSecrets: deps.featureSecrets,
    providers: deps.providers,
    models: deps.models,
    jobDefaults: deps.jobDefaults,
    projectOverrides: deps.projectOverrides,
    featureOverrides: deps.featureOverrides,
  });

  async function getOwnedProject(req: Parameters<typeof requireAuth>[0], projectId: string) {
    if (!isUuid(projectId)) {
      return null;
    }
    const user = req.currentUser;
    if (!user) return null;
    return deps.projects.findByIdForUser(projectId, user.id);
  }

  function parseFeatureId(featureId: string): string | null {
    return isUuid(featureId) ? featureId : null;
  }

  async function toPublicProjectWithRemovalMeta(project: Project) {
    const repositoryRemovalBlockedReason = await getRepositoryRemovalBlockedReason(
      project,
      deps.features,
      deps.jobs,
    );
    return toPublicProject(project, repositoryRemovalBlockedReason);
  }

  async function assertInstallationReady(installationId: string): Promise<string | null> {
    const installation = await deps.installations.findById(installationId);
    if (!installation || installation.suspendedAt) {
      return "GitHub App installation not found or suspended";
    }
    return null;
  }

  async function assertReposOnInstallation(
    installationId: string,
    repositories: Array<{ githubOwner: string; githubRepo: string }>,
  ): Promise<string | null> {
    for (const repo of repositories) {
      const fullName = `${repo.githubOwner.trim()}/${repo.githubRepo.trim()}`;
      const granted = await deps.installations.hasRepository(installationId, fullName);
      if (!granted) {
        return `Repository ${fullName} is not granted on the GitHub App installation`;
      }
    }
    return null;
  }

  function assertGitHubAccess(project: Project): string | null {
    if (project.githubAccessWarning) {
      return "GitHub access for this project needs to be fixed before running jobs";
    }
    if (!project.installationId) {
      return "Project is missing a GitHub App installation";
    }
    return null;
  }

  /**
   * Gate enforced at every job-dispatch site (ADR 007, per-job-kind since
   * ADR 018, feature-tier aware since the ADR 018 amendment / issue #5):
   * resolves live for the job kind about to be dispatched — through the
   * feature, project, and organization tiers — and refuses to dispatch if
   * nothing resolves. Distinct from `assertGitHubAccess` — model config and
   * repo access are independent prerequisites.
   *
   * `featureId` is passed by the feature-scoped dispatch sites (start build,
   * retry build, retry grill, restart, resume) and omitted where no feature
   * exists yet (feature creation) or where the job doesn't belong to one (a
   * `design_grill` session, which is project-scoped even when started from a
   * feature's Action Item — ADR 014).
   */
  async function assertModelConfigResolvable(
    project: Project,
    jobKind: AgentJobKind,
    featureId?: string | null,
  ): Promise<string | null> {
    const resolved = await resolveModelConfigForJob(
      modelConfigDeps(),
      project.id,
      project.organizationId,
      jobKind,
      featureId,
    );
    if (resolved) {
      return null;
    }
    const featureHint = featureId ? ", or configure this feature" : "";
    return "No model configuration is set for this feature, project, or its organization. " +
      `Set one in Organization settings, or configure this project${featureHint} directly on its settings page.`;
  }

  /**
   * Resolves which Organization a new project belongs to (ADR 016 items 2, 4
   * & 6): the caller's chosen org if provided and they're a member, else
   * their personal org. Returns an error message on failure.
   */
  async function resolveOrgForProject(
    userId: string,
    requestedOrgId?: string,
  ): Promise<{ org: { id: string; status: string; role: string } } | { error: string }> {
    let orgId = requestedOrgId;
    let org = orgId ? await deps.organizations.findById(orgId) : null;

    if (!org) {
      const personal = await deps.organizations.findPersonalByUser(userId);
      if (personal) {
        org = personal;
        orgId = personal.id;
      }
    }
    if (!org) {
      return { error: "No organization found for project creation." };
    }

    const role = await deps.organizations.roleForUser(org.id, userId);
    if (!role) {
      return { error: "You are not a member of this organization." };
    }
    return { org: { id: org.id, status: org.status, role } };
  }

  /**
   * Hard gate on project creation (ADR 016 items 11-13): every Organization
   * must explicitly configure its own Kubernetes cluster before it can do
   * anything else — there is no platform-default cluster. Blocks on the
   * owning org's readiness, not a personal-org assumption.
   */
  function assertClusterGate(orgStatus: string): string | null {
    if (orgStatus !== "ready") {
      return "Configure a Kubernetes cluster in your organization settings before creating a project.";
    }
    return null;
  }

  /**
   * Role-based authorization (ADR 016 item 6-7): checks the caller's role in
   * the project's owning org against the adjustable capability matrix. A
   * role with `full` or `partial` for a capability may perform the action;
   * `none` (or a non-member) is denied. The matrix is seed data, so this is
   * data-driven — no per-role branches in application logic.
   */
  async function assertCapabilityForProject(
    req: Parameters<typeof requireAuth>[0],
    project: Project,
    capability: string,
  ): Promise<string | null> {
    const user = req.currentUser;
    if (!user) {
      return "Unauthorized";
    }
    const role = await deps.organizations.roleForUser(project.organizationId, user.id);
    if (!role) {
      return "You are not a member of this project's organization";
    }
    const matrix = await deps.organizations.listRoleCapabilities();
    const grant = matrix.find((c) => c.role === role && c.capability === capability);
    if (!grant || grant.level === "none") {
      return "Your role does not have permission to do this";
    }
    return null;
  }

  router.get("/", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    const projects = await deps.projects.listForUser(user.id);
    const publicProjects = await Promise.all(
      projects.map((project) => toPublicProjectWithRemovalMeta(project)),
    );
    res.json(publicProjects);
  });

  router.post("/", requireAuth, async (req, res) => {
    const parsed = parseBody(createProjectSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const user = req.currentUser!;

    const orgResolution = await resolveOrgForProject(user.id, parsed.data.organizationId);
    if ("error" in orgResolution) {
      res.status(400).json({ error: orgResolution.error });
      return;
    }
    const { org } = orgResolution;

    const clusterGateError = assertClusterGate(org.status);
    if (clusterGateError) {
      res.status(400).json({ error: clusterGateError });
      return;
    }

    const installationError = await assertInstallationReady(parsed.data.installationId);
    if (installationError) {
      res.status(400).json({ error: installationError });
      return;
    }

    const repoError = await assertReposOnInstallation(
      parsed.data.installationId,
      parsed.data.repositories,
    );
    if (repoError) {
      res.status(400).json({ error: repoError });
      return;
    }

    // Resolve model config before creating anything (ADR 018): a request bundle
    // wins, else the project inherits its org's defaults. There is no per-user
    // default anymore (ADR 007 retired).
    //
    // Issue #35 tightened the second half of this. It used to require a default for
    // `spec_grill` alone, which is weaker than ADR 018 item 6a's "all five
    // agent-driven job kinds" — so an org could create a project that then had its
    // `feature_build`/`test_run`/`agentic_review`/`design_grill` jobs fail at *run*
    // time on a missing model, which is the failure item 6a's gate exists to catch
    // at creation instead. Both the gate and the onboarding readiness signal now
    // call one predicate (`organizations/readiness.ts`), because a readiness check
    // that disagrees with the gate promises a form will work and then 400s.
    //
    // **The escape hatch is preserved** (ADR 018 item 5): a complete request bundle
    // resolves for every job kind at the project tier, so it satisfies this
    // dimension outright. Requiring org coverage on top of a supplied bundle would
    // retire a documented, tested capability rather than implement the ADR.
    const requestedModelConfig = parsed.data.modelConfig
      ? toModelConfigBundle(parsed.data.modelConfig)
      : null;
    let effectiveModelConfig = requestedModelConfig;
    if (!effectiveModelConfig) {
      const coverage = await evaluateModelCoverage(deps, org.id);
      if (coverage.missing.length === 0) {
        const orgDefault = await deps.jobDefaults.findForJobKind(org.id, "spec_grill");
        effectiveModelConfig = orgDefault
          ? await resolveOrgModelConfig(deps, org.id, orgDefault.modelId)
          : null;
      }
      if (!effectiveModelConfig) {
        // The message names what is missing rather than the old blanket instruction:
        // "set a default model configuration" is unhelpful to an admin who has set
        // four of five, or whose default stopped resolving because its provider was
        // deleted. Both are distinct remedies and the sentence now distinguishes them.
        res.status(400).json({
          error:
            "Set a default model configuration in Organization settings, or provide one for this project. " +
            describeMissingModelKinds(coverage),
        });
        return;
      }
    }

    const project = await deps.projects.create({
      organizationId: org.id,
      ownerUserId: user.id,
      name: parsed.data.name,
      description: parsed.data.description,
      installationId: parsed.data.installationId,
      repositories: parsed.data.repositories,
    });

    await deps.audit.record(res, {
      organizationId: org.id,
      projectId: project.id,
      actorUserId: user.id,
      action: AUDIT_ACTIONS.projectCreated,
      targetType: "project",
      targetId: project.id,
      metadata: {
        name: project.name,
        slug: project.slug,
        repositories: parsed.data.repositories.map(
          (repo) => `${repo.githubOwner}/${repo.githubRepo}`,
        ),
      },
    });

    if (requestedModelConfig) {
      for (const key of MODEL_CONFIG_KEYS) {
        await deps.secrets.upsert(project.id, key, requestedModelConfig[key]);
      }
    }

    const initFeature = await deps.features.create({
      projectId: project.id,
      title: "Project initialization",
      featureType: "project_init",
    });

    await dispatchJob(deps.jobs, {
      projectId: project.id,
      kind: "spec_grill",
      featureId: initFeature.id,
    });

    await deps.notifications.create({
      userId: user.id,
      projectId: project.id,
      kind: "project_created",
      title: `${project.name} created`,
      body: "Complete project initialization to unlock features and tests.",
      linkPath: `/projects/${project.id}`,
    });

    // Best-effort: scaffolding the Helm chart (ADR 003 §12) never blocks
    // project creation — a failure here just means the Orchestrator falls
    // back to its embedded placeholder chart at deploy time.
    const installation = await deps.installations.findById(parsed.data.installationId);
    if (installation) {
      const scaffolded = await scaffoldChart(project, installation);
      if (!scaffolded) {
        await deps.notifications.create({
          userId: user.id,
          projectId: project.id,
          kind: "chart_scaffold_failed",
          title: `Couldn't scaffold Helm chart for ${project.name}`,
          body: "Deploys will use a placeholder chart until this is resolved.",
          linkPath: `/projects/${project.id}`,
        });
        await deps.audit.record(res, {
          organizationId: org.id,
          projectId: project.id,
          actorUserId: user.id,
          action: AUDIT_ACTIONS.projectChartScaffoldFailed,
          targetType: "project",
          targetId: project.id,
        });
      }
    }

    res.status(201).json(await toPublicProjectWithRemovalMeta(project));
  });

  router.get("/:projectId", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(await toPublicProjectWithRemovalMeta(project));
  });

  router.post("/:projectId/repositories", requireAuth, async (req, res) => {
    const parsed = parseBody(addSubRepositorySchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!project.installationId) {
      res.status(409).json({ error: "Project is missing a GitHub App installation" });
      return;
    }

    const installationError = await assertInstallationReady(project.installationId);
    if (installationError) {
      res.status(409).json({ error: installationError });
      return;
    }

    const repoError = await assertReposOnInstallation(project.installationId, [
      parsed.data,
    ]);
    if (repoError) {
      res.status(400).json({ error: repoError });
      return;
    }

    if (
      deps.projects.matchesPrimaryRepository(
        project,
        parsed.data.githubOwner,
        parsed.data.githubRepo,
      )
    ) {
      res.status(409).json({ error: "Primary repository is already linked to this project" });
      return;
    }

    try {
      const created = await deps.projects.addSubRepository(project.id, parsed.data);
      if (!created) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Repository is already linked to this project"
      ) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }

    const updated = await deps.projects.findByIdForUser(project.id, req.currentUser!.id);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.projectRepositoryLinked,
      targetType: "project",
      targetId: project.id,
      metadata: {
        repository: `${parsed.data.githubOwner}/${parsed.data.githubRepo}`,
      },
    });

    res.status(201).json(await toPublicProjectWithRemovalMeta(updated));
  });

  router.delete("/:projectId/repositories/:repositoryId", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const repositoryId = routeParam(req.params.repositoryId);
    if (!isUuid(repositoryId)) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }

    const blockedReason = await getRepositoryRemovalBlockedReason(
      project,
      deps.features,
      deps.jobs,
    );
    if (blockedReason) {
      res.status(409).json({ error: blockedReason });
      return;
    }

    const result = await deps.projects.deleteSubRepository(project.id, repositoryId);
    if (result === "not_found") {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    if (result === "primary") {
      res.status(409).json({ error: "Primary repository cannot be removed" });
      return;
    }

    const updated = await deps.projects.findByIdForUser(project.id, req.currentUser!.id);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.projectRepositoryUnlinked,
      targetType: "project",
      targetId: project.id,
      metadata: { repositoryId },
    });

    res.json(await toPublicProjectWithRemovalMeta(updated));
  });

  router.post("/:projectId/complete-init", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.status !== "initializing") {
      res.status(409).json({ error: "Project initialization is already complete" });
      return;
    }

    const initFeature = await deps.features.findProjectInit(project.id);
    if (initFeature && initFeature.status !== "merged") {
      await deps.features.updateStatus(initFeature.id, "merged");
    }

    await deps.projects.markReady(project.id);
    // A project going 'ready' is exactly the moment its always-on primary
    // deployment (ADR 003 §9, `deploy` job) should first exist — without
    // this, nothing ever deploys `main` until some *later* push happens to
    // land on an already-`ready` project (see ADR 013 addendum: the
    // pull_request-webhook path has the identical gap and fix).
    //
    // This is a project's *first* deploy, so it cannot conflict with anything —
    // but the dispatch is the same call as everywhere else, and a conflict here
    // (another project-init race already dispatched it) means the deploy exists,
    // which is the outcome this line wants either way.
    await dispatchDeployJob(deps.jobs, {
      projectId: project.id,
      kind: "deploy",
      ref: "main",
    });

    const updated = await deps.projects.findByIdForUser(project.id, req.currentUser!.id);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.projectMarkedReady,
      targetType: "project",
      targetId: project.id,
      metadata: { name: project.name },
    });

    res.json(await toPublicProjectWithRemovalMeta(updated));
  });

  // Reads the project's most recent deployment operation (ADR 013 addendum,
  // widened to rollbacks by ADR 022) so the Web app can show whether the
  // always-on primary deployment is up to date, still rolling out, or last
  // failed. Deploy and rollback jobs carry no curated event stream (unlike
  // spec_grill/feature_build): the Orchestrator runs them synchronously
  // in-process and reports only pending → running → completed/failed +
  // last_error, so job status/lastError is the whole picture here.
  //
  // Deliberately spans both kinds: after a rollback the latest *deploy* is no
  // longer the newest operation, and reporting it anyway would tell an
  // operator the project is running one revision when it is running another.
  router.get("/:projectId/deploy", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const job = await deps.jobs.findLatestByProjectAndKinds(project.id, [
      "deploy",
      "rollback",
    ]);
    const revision = await deps.deploys.currentRevision(project.id);
    res.json({
      status: job?.status ?? null,
      lastError: job?.lastError ?? null,
      startedAt: job?.startedAt ?? null,
      completedAt: job?.completedAt ?? null,
      // Which operation is being reported — the Web app labels a rollback as
      // one rather than as a fresh deploy.
      kind: job?.kind ?? null,
      // The revision currently live, from the deploy ledger (ADR 022). Null
      // before the first successful deploy.
      revision,
      // Deterministic from the project slug (ADR 003 §15,
      // docs/conventions/deploy.md's URL scheme) — always present
      // regardless of job status; the Web app only links to it once
      // `status === "completed"` confirms something is actually running.
      url: buildDeployUrl(project.slug),
    });
  });

  // A project's deploy history and the revisions it can be rolled back to
  // (ADR 022). Read-only; the rollback itself is a separate mutation below.
  router.get("/:projectId/deploys", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const [deploys, currentRevision, rollbackTargets] = await Promise.all([
      deps.deploys.listForProject(project.id),
      deps.deploys.currentRevision(project.id),
      deps.deploys.listRollbackTargets(project.id),
    ]);

    res.json({
      deploys: deploys.map(toPublicProjectDeploy),
      currentRevision,
      rollbackTargets: rollbackTargets.map((target) => ({
        revision: target.revision,
        deployedAt: target.deployedAt.toISOString(),
        kind: target.kind,
      })),
      url: buildDeployUrl(project.slug),
    });
  });

  // Rolls the project's primary deployment back to an earlier Helm revision
  // (ADR 022) — the safety net ADR 003 §9 shipped without.
  //
  // Enqueues a `rollback` job rather than calling the Orchestrator
  // synchronously: the Postgres queue is the durability boundary for every
  // other cluster-mutating operation (ADR 003 §18), so routing this one around
  // it would give rollback weaker crash-safety than the deploys it exists to
  // undo. Not agent-driven — the Orchestrator runs it deterministically.
  router.post("/:projectId/rollback", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const parsed = parseBody(
      z.object({ revision: z.number().int().positive() }),
      req.body,
    );
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    // Only revisions this project actually produced are rollback targets —
    // an arbitrary integer would otherwise reach Helm and fail there, or in
    // the worst case name a revision that never applied.
    const known = await deps.deploys.hasRevision(project.id, parsed.data.revision);
    if (!known) {
      res.status(404).json({ error: "Unknown revision for this project" });
      return;
    }

    const current = await deps.deploys.currentRevision(project.id);
    if (current !== null && current === parsed.data.revision) {
      res.status(409).json({ error: "That revision is already deployed" });
      return;
    }

    // One deployment operation at a time per project. A concurrent deploy
    // would race this rollback on the same Helm release; Helm refuses the
    // second operation while the first is pending, which would surface as a
    // confusing failure rather than as "something is already running".
    const inFlight = await deps.jobs.findLatestByProjectAndKinds(project.id, [
      "deploy",
      "rollback",
    ]);
    if (inFlight && (inFlight.status === "pending" || inFlight.status === "running")) {
      res.status(409).json({ error: "A deployment operation is already in progress" });
      return;
    }

    const job = await dispatchDeployJob(deps.jobs, {
      projectId: project.id,
      kind: "rollback",
      targetRevision: parsed.data.revision,
      // A rollback applies no new commit, so the honest "which commit is
      // deployed" for the row it is about to write is the one the target
      // revision was deployed from (issue #26). Null for a target recorded
      // before that ref was populated, which the job schema spells as absent.
      ref: (await deps.deploys.refForRevision(project.id, parsed.data.revision)) ?? undefined,
    });
    if ("conflict" in job) {
      // The pre-check above passed but another request inserted first. Both
      // would touch the same Helm release, so the loser is refused rather than
      // left to fail inside Helm with a less intelligible error.
      res.status(409).json({ error: "A deployment operation is already in progress" });
      return;
    }

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.deployRolledBack,
      targetType: "project",
      targetId: project.id,
      metadata: {
        // Both numbers matter: `revision` is what was live and is being undone,
        // `targetRevision` is what the operator asked to go back to.
        revision: current,
        targetRevision: parsed.data.revision,
        jobId: job.job.id,
      },
    });

    res.status(201).json({});
  });

  // Manually (re)dispatches a `deploy` job — the "Deploy now" action for a
  // project that's already `ready` but needs an out-of-band redeploy
  // (rotated secrets, a chart change with no code change, or recovering a
  // project whose guaranteed first deploy predates this endpoint). Guarded
  // the same way retry-build guards against a duplicate build: no-op if a
  // deploy is already pending/running rather than piling up a second one.
  router.post("/:projectId/deploy", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.status !== "ready") {
      res.status(409).json({ error: "Project is not ready to deploy yet" });
      return;
    }

    const latestJob = await deps.jobs.findLatestByProjectAndKinds(project.id, [
      "deploy",
      "rollback",
    ]);
    if (latestJob && (latestJob.status === "pending" || latestJob.status === "running")) {
      res.status(409).json({ error: "A deployment operation is already in progress for this project" });
      return;
    }

    const job = await dispatchDeployJob(deps.jobs, {
      projectId: project.id,
      kind: "deploy",
      // The primary deployment is always the default branch's content (ADR 003
      // §9), and the webhook path only ever deploys `main` — so a manual
      // redeploy (rotated secrets, a chart change with no code change) is a
      // deploy of `main` too (issue #26).
      ref: "main",
    });
    if ("conflict" in job) {
      res.status(409).json({ error: "A deployment operation is already in progress for this project" });
      return;
    }

    // Audited even though the routine push-driven deploy is not: this is the
    // only deploy an operator triggers by hand, and the asymmetry with
    // rollback was the thing that read wrong (issue #26, ADR 022 §8). A
    // webhook deploy has no actor to record and would repeat on every push.
    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.deployTriggered,
      targetType: "project",
      targetId: project.id,
      metadata: { ref: "main", jobId: job.job.id },
    });

    res.status(201).json({});
  });

  // ADR 015 item 12 / Track B6: per-project Agentic Review gate, default on.
  // Exposes the `projects.agentic_review_enabled` column that the model and
  // repository already plumbed but no route surfaced — without this the
  // toggle is dead data. Only the boolean flips; the workspace PR/capsule is
  // untouched.
  router.patch("/:projectId", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const parsed = parseBody(
      z.object({
        agenticReviewEnabled: z.boolean(),
      }),
      req.body,
    );
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    await deps.projects.setAgenticReviewEnabled(
      project.id,
      parsed.data.agenticReviewEnabled,
    );

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.projectUpdated,
      targetType: "project",
      targetId: project.id,
      metadata: { agenticReviewEnabled: parsed.data.agenticReviewEnabled },
    });

    const updated = await deps.projects.findByIdForUser(project.id, req.currentUser!.id);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(await toPublicProjectWithRemovalMeta(updated));
  });

  /**
   * Issue #31 part 1: the zone this project's test schedules are read in.
   *
   * A dedicated route rather than a field on the `/:projectId` PATCH above, for
   * the reason the uploaded-extensions route below gives: that schema makes
   * `agenticReviewEnabled` **required**, so adding an optional field would either
   * change an existing endpoint's contract or force every caller to restate a
   * toggle it is not editing.
   *
   * **Validated on write.** `isValidTimeZone` rejects a value this runtime cannot
   * resolve, so a typo is a `400` here rather than a project quietly scheduling
   * in UTC forever. Readers still tolerate an invalid *stored* value — the set of
   * resolvable zones can differ between deploys, and a bad row must not wedge the
   * scheduler — so write-validated and read-tolerant are deliberately different
   * postures. `timeZoneOrUtc` holds the other half.
   *
   * `null` clears the setting back to the default rather than storing `"UTC"`:
   * the two mean the same thing to every reader, and one representation of the
   * default is better than two to reconcile.
   *
   * Audited, because changing a schedule's timezone changes *when a job runs* —
   * the same class of change as editing its cron expression.
   */
  router.put("/:projectId/timezone", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const parsed = parseBody(
      z.object({
        // Nullable and optional: `null` and absent both mean "clear it". A
        // caller omitting the field is not making a mistake, it is asking for
        // the default.
        timeZone: z.string().trim().max(64).nullable().optional(),
      }),
      req.body,
    );
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const requested = parsed.data.timeZone ?? null;
    if (requested !== null && !isValidTimeZone(requested)) {
      // Names it as a zone problem explicitly: "invalid input" would send an
      // operator looking for a payload-shape fault rather than a typo in a zone
      // name, and the field is free-form to the caller.
      res.status(400).json({ error: `Unknown time zone: ${requested}` });
      return;
    }

    await deps.projects.setTimeZone(project.id, requested);

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.projectUpdated,
      targetType: "project",
      targetId: project.id,
      metadata: { timeZone: requested },
    });

    res.json({ timeZone: requested });
  });

  // ADR 025 item 7: per-project opt-in for uploaded Pi extensions. Separate
  // route from the `/:projectId` PATCH above rather than another field on it,
  // because the two toggles have very different weight: the agentic-review
  // gate changes how a build is reviewed, this one decides whether code an
  // admin uploaded runs inside the project's job containers. Same
  // project-membership gate as every other project setting (ADR 018 item 6) —
  // the *upload* is the org-admin action, this is the project owner opting in.
  router.patch("/:projectId/uploaded-extensions-enabled", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const parsed = parseBody(
      z.object({
        uploadedExtensionsEnabled: z.boolean(),
      }),
      req.body,
    );
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    await deps.projects.setUploadedExtensionsEnabled(
      project.id,
      parsed.data.uploadedExtensionsEnabled,
    );

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.projectUploadedExtensionsChanged,
      targetType: "project",
      targetId: project.id,
      metadata: { uploadedExtensionsEnabled: parsed.data.uploadedExtensionsEnabled },
    });

    const updated = await deps.projects.findByIdForUser(project.id, req.currentUser!.id);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(await toPublicProjectWithRemovalMeta(updated));
  });

  router.delete("/:projectId", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const parsed = parseBody(z.object({ confirm: z.string().min(1) }), req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (parsed.data.confirm !== "delete") {
      res.status(400).json({ error: 'Type "delete" to confirm' });
      return;
    }

    const blocker = await getProjectDeletionBlocker(project, deps.features, deps.jobs);
    if (blocker) {
      res.status(409).json({
        error: blocker.reason,
        features: blocker.features,
        testRuns: blocker.testRuns,
      });
      return;
    }

    await deps.projects.delete(project.id);
    await deps.audit.record(res, {
      organizationId: project.organizationId,
      // The project row is gone (project_id is ON DELETE SET NULL), so this
      // event keeps the name in metadata as the only remaining record of
      // what was deleted.
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.projectDeleted,
      targetType: "project",
      metadata: { name: project.name, slug: project.slug },
    });
    res.status(204).send();
  });

  router.get("/:projectId/overview", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const overview = await buildProjectOverview({
      projectId: project.id,
      projectSlug: project.slug,
      githubAccessWarning: project.githubAccessWarning,
      modelConfigWarning: project.modelConfigWarning,
      features: deps.features,
      jobs: deps.jobs,
      tests: deps.tests,
    });

    res.json(overview);
  });

  router.get("/:projectId/features", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const features = await deps.features.listByProject(project.id);
    res.json(features.map(toPublicFeature));
  });

  router.post("/:projectId/features", requireAuth, async (req, res) => {
    const parsed = parseBody(createFeatureSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.status === "initializing") {
      res.status(409).json({
        error: "Project initialization must complete before creating features",
      });
      return;
    }

    const accessError = assertGitHubAccess(project);
    if (accessError) {
      res.status(409).json({ error: accessError });
      return;
    }

    const modelConfigError = await assertModelConfigResolvable(project, "spec_grill");
    if (modelConfigError) {
      res.status(400).json({ error: modelConfigError });
      return;
    }

    const capabilityError = await assertCapabilityForProject(req, project, "manage_features");
    if (capabilityError) {
      res.status(403).json({ error: capabilityError });
      return;
    }

    const feature = await deps.features.create({
      projectId: project.id,
      title: parsed.data.title,
    });

    await dispatchJob(deps.jobs, {
      projectId: project.id,
      kind: "spec_grill",
      featureId: feature.id,
    });

    const user = req.currentUser!;
    await deps.notifications.create({
      userId: user.id,
      projectId: project.id,
      kind: "feature_created",
      title: `Spec grill started: ${feature.title}`,
      linkPath: `/projects/${project.id}/features/${feature.id}`,
    });

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: user.id,
      action: AUDIT_ACTIONS.featureCreated,
      targetType: "feature",
      targetId: feature.id,
      metadata: { title: feature.title, featureType: feature.featureType },
    });

    res.status(201).json(toPublicFeature(feature));
  });

  router.get("/:projectId/features/:featureId", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const featureId = parseFeatureId(routeParam(req.params.featureId));
    if (!featureId) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const feature = await deps.features.findById(project.id, featureId);
    if (!feature) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    res.json(toPublicFeature(feature));
  });

  router.get("/:projectId/features/:featureId/testing", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const featureId = parseFeatureId(routeParam(req.params.featureId));
    if (!featureId) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const feature = await deps.features.findById(project.id, featureId);
    if (!feature) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const reports = await deps.testRunReports.listByFeature(feature.id);
    res.json({
      featureId: feature.id,
      status: feature.status,
      runs: reports.map(toPublicTestRunExecution),
    });
  });

  /**
   * Issue #59: the feature's Agentic Review verdict (ADR 015 items 14-16).
   *
   * The stage's tab has been calling this path since it was built and getting a
   * 404 — no read endpoint ever existed — so the tab reported "Unable to load
   * agentic review." for a feature that had simply never been reviewed. That is
   * the failure this route fixes, and it is why **a feature with no review
   * answers 200 with `verdict: null`** rather than 404: the two states are
   * genuinely different, and collapsing them is what made the tab unusable.
   *
   * Gated exactly like the sibling feature routes (`getOwnedProject`, then the
   * feature has to belong to that project) rather than with a new capability,
   * matching `GET /testing` immediately above.
   *
   * Returns the *most recent* verdict rather than a history: a feature can be
   * returned and re-reviewed, and the tab asks what the reviewer decided last.
   * `findLatestReviewByFeature` documents why that is not the same question as
   * "the reviews of the latest review job".
   */
  router.get("/:projectId/features/:featureId/agentic-review", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const featureId = parseFeatureId(routeParam(req.params.featureId));
    if (!featureId) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const feature = await deps.features.findById(project.id, featureId);
    if (!feature) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const review = await deps.jobEvents.findLatestReviewByFeature(feature.id);
    res.json(toPublicAgenticReview(review));
  });

  router.patch("/:projectId/features/:featureId", requireAuth, async (req, res) => {
    const parsed = parseBody(updateFeatureSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const featureId = parseFeatureId(routeParam(req.params.featureId));
    if (!featureId) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    let feature = await deps.features.findById(project.id, featureId);
    if (!feature) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    if (parsed.data.adrMarkdown !== undefined) {
      if (feature.status !== "spec_ready" && feature.status !== "draft") {
        res.status(409).json({ error: "ADR can only be edited during spec review" });
        return;
      }
      const updated = await deps.features.updateAdr(feature.id, parsed.data.adrMarkdown);
      feature = updated ?? feature;
    }

    if (parsed.data.approveAdr) {
      if (feature.status !== "spec_ready") {
        res.status(409).json({ error: "Feature is not ready for ADR approval" });
        return;
      }
      const updated = await deps.features.approveAdr(feature.id);
      feature = updated ?? feature;

      const user = req.currentUser!;
      await deps.notifications.create({
        userId: user.id,
        projectId: project.id,
        kind: "adr_approved",
        title: `ADR approved: ${feature.title}`,
        body: "Start build when ready.",
        linkPath: `/projects/${project.id}/features/${feature.id}`,
      });
      await deps.audit.record(res, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorUserId: user.id,
        action: AUDIT_ACTIONS.featureAdrApproved,
        targetType: "feature",
        targetId: feature.id,
        metadata: { title: feature.title },
      });
    }

    if (parsed.data.startBuild) {
      if (feature.status !== "spec_ready" || !feature.adrApproved) {
        res.status(409).json({ error: "Approve the ADR before starting build" });
        return;
      }

      // ADR 015 item 2: "Start build" stays disabled until every Action Item
      // on the current batch is resolved.
      const openItems = await deps.actionItems.countOpenForFeature(feature.id);
      if (openItems > 0) {
        res.status(409).json({
          error: `${openItems} Action Item${openItems === 1 ? "" : "s"} must be resolved before starting build`,
        });
        return;
      }

      const accessError = assertGitHubAccess(project);
      if (accessError) {
        res.status(409).json({ error: accessError });
        return;
      }

      const modelConfigError = await assertModelConfigResolvable(project, "feature_build", feature.id);
      if (modelConfigError) {
        res.status(400).json({ error: modelConfigError });
        return;
      }

      const updated = await deps.features.queueBuild(feature.id);
      if (!updated) {
        res.status(409).json({ error: "Unable to queue build" });
        return;
      }
      feature = updated;

      await dispatchJob(deps.jobs, {
        projectId: project.id,
        kind: "feature_build",
        featureId: feature.id,
      });

      const user = req.currentUser!;
      await deps.notifications.create({
        userId: user.id,
        projectId: project.id,
        kind: "build_started",
        title: `Build started: ${feature.title}`,
        linkPath: `/projects/${project.id}/features/${feature.id}`,
      });
      await deps.audit.record(res, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorUserId: user.id,
        action: AUDIT_ACTIONS.featureBuildStarted,
        targetType: "feature",
        targetId: feature.id,
        metadata: { title: feature.title },
      });
    }

    res.json(toPublicFeature(feature));
  });

  // Queues a human's reply to a running spec_grill job's ask_user question
  // (ADR 006 items 9-10). The Orchestrator picks it up via Postgres
  // LISTEN/NOTIFY on 'job_replies'. Also records the reply as a 'user_message'
  // job_event so it appears in GET .../events alongside agent-authored events
  // and survives a page refresh, since the Web app only reads from job_events.
  router.post("/:projectId/features/:featureId/messages", requireAuth, async (req, res) => {
    const parsed = parseBody(createFeatureMessageSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const featureId = parseFeatureId(routeParam(req.params.featureId));
    if (!featureId) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const feature = await deps.features.findById(project.id, featureId);
    if (!feature) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const job = await deps.jobs.findActiveSpecGrillJob(featureId);
    if (!job) {
      res.status(409).json({ error: "No active grill session is waiting for a reply" });
      return;
    }

    await deps.jobMessages.create({ jobId: job.id, content: parsed.data.content });
    await deps.jobEvents.create({ jobId: job.id, type: "user_message", message: parsed.data.content });
    await deps.features.setAwaitingUserInput(featureId, false);
    res.status(201).json({});
  });

  // ADR 014: design_grill is a project-scoped, single-phase session rather
  // than a Feature. Its identity lives on the job row until the unresolved
  // Design-persistence decision is made.
  router.post("/:projectId/designs", requireAuth, async (req, res) => {
    const parsed = parseBody(createDesignSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (project.status !== "ready") {
      res.status(409).json({ error: "Project initialization must complete before starting a design session" });
      return;
    }
    if (!project.hasDesignSurface) {
      res.status(409).json({ error: "Design sessions are not enabled for this project" });
      return;
    }
    if (parsed.data.actionItemId && !parsed.data.featureId) {
      res.status(400).json({ error: "featureId is required when linking a design Action Item" });
      return;
    }
    if (parsed.data.featureId && parsed.data.actionItemId) {
      const feature = await deps.features.findById(project.id, parsed.data.featureId);
      const item = feature
        ? await deps.actionItems.findById(feature.id, parsed.data.actionItemId)
        : null;
      if (!feature || !item || item.type !== "design_grill" || item.status !== "open") {
        res.status(400).json({ error: "Design Action Item is not available" });
        return;
      }
    }
    const capabilityError = await assertCapabilityForProject(req, project, "design_sessions");
    if (capabilityError) {
      res.status(403).json({ error: capabilityError });
      return;
    }
    const accessError = assertGitHubAccess(project);
    if (accessError) {
      res.status(409).json({ error: accessError });
      return;
    }
    // No feature id: a design session is project-scoped (ADR 014), even when
    // it was started from one feature's Action Item — its job row carries no
    // feature_id, and the feature tier therefore doesn't apply to it.
    const modelConfigError = await assertModelConfigResolvable(project, "design_grill");
    if (modelConfigError) {
      res.status(400).json({ error: modelConfigError });
      return;
    }

    const designSlug = parsed.data.slug ?? slugify(parsed.data.name);
    if (!designSlug) {
      res.status(400).json({ error: "Design name must contain a letter or number" });
      return;
    }
    const job = await dispatchJob(deps.jobs, {
      projectId: project.id,
      kind: "design_grill",
      designName: parsed.data.name,
      designSlug,
      designDescription: parsed.data.description,
    });

    // ADR 020 item 2: the design becomes an index row the moment a session
    // works on it, so browse/history shows designs in flight and not only
    // finalized ones. Upsert on (project_id, slug) is what makes re-opening a
    // design the same call as starting one — the slug is the artifact's
    // identity on disk, so it can never produce a second row for one folder.
    //
    // Best-effort, like the notification and audit side effects below: the job
    // is already dispatched and genuinely running, so failing the request here
    // would report a failure the user cannot act on. It is also self-healing —
    // `finalize` upserts, so a design that reaches `submit_design` always ends
    // up indexed even if this write was lost.
    let designId: string | null = null;
    try {
      const design = await deps.designs.startSession({
        projectId: project.id,
        name: parsed.data.name,
        slug: designSlug,
        jobId: job.id,
      });
      designId = design.id;
    } catch (error) {
      console.error(`failed to index design session ${job.id}:`, error);
    }

    if (parsed.data.featureId && parsed.data.actionItemId) {
      await deps.actionItems.linkDesignSession(
        parsed.data.featureId,
        parsed.data.actionItemId,
        job.id,
      );
    }
    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      action: AUDIT_ACTIONS.designSessionStarted,
      targetType: "design",
      targetId: designId,
      metadata: { name: parsed.data.name, slug: designSlug, sessionId: job.id },
    });
    res.status(201).json({
      id: job.id,
      name: parsed.data.name,
      slug: designSlug,
      description: parsed.data.description,
      status: job.status,
      createdAt: job.createdAt?.toISOString?.() ?? new Date().toISOString(),
      designId,
    });
  });

  router.get("/:projectId/designs/:sessionId/events", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const sessionId = routeParam(req.params.sessionId);
    if (!isUuid(sessionId)) {
      res.status(404).json({ error: "Design session not found" });
      return;
    }
    const job = await deps.jobs.findByIdForProject(project.id, sessionId);
    if (!job || job.kind !== "design_grill") {
      res.status(404).json({ error: "Design session not found" });
      return;
    }
    const events = await deps.jobEvents.listByJob(job.id);
    res.json({
      session: {
        id: job.id,
        name: job.designName,
        slug: job.designSlug,
        description: job.designDescription,
        status: job.status,
        createdAt: job.createdAt.toISOString(),
      },
      jobStatus: job.status,
      lastError: job.lastError,
      events,
    });
  });

  router.post("/:projectId/designs/:sessionId/messages", requireAuth, async (req, res) => {
    const parsed = parseBody(createFeatureMessageSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const sessionId = routeParam(req.params.sessionId);
    if (!isUuid(sessionId)) {
      res.status(404).json({ error: "Design session not found" });
      return;
    }
    const job = await deps.jobs.findByIdForProject(project.id, sessionId);
    if (!job || job.kind !== "design_grill" || job.status !== "running") {
      res.status(409).json({ error: "No active design session is waiting for a reply" });
      return;
    }
    const events = await deps.jobEvents.listByJob(job.id);
    const lastAsk = events.map((event) => event.type === "ask_user").lastIndexOf(true);
    const lastReply = events.map((event) => event.type === "user_message").lastIndexOf(true);
    if (lastAsk < 0 || lastReply >= lastAsk) {
      res.status(409).json({ error: "The design agent is not waiting for a reply" });
      return;
    }
    await deps.jobMessages.create({ jobId: job.id, content: parsed.data.content });
    await deps.jobEvents.create({ jobId: job.id, type: "user_message", message: parsed.data.content });
    res.status(201).json({});
  });

  router.post("/:projectId/designs/:sessionId/cancel", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const sessionId = routeParam(req.params.sessionId);
    if (!isUuid(sessionId)) {
      res.status(404).json({ error: "Design session not found" });
      return;
    }
    const job = await deps.jobs.findByIdForProject(project.id, sessionId);
    if (!job || job.kind !== "design_grill") {
      res.status(404).json({ error: "Design session not found" });
      return;
    }
    if (!(await deps.jobs.cancel(job.id))) {
      res.status(409).json({ error: "No active design session to cancel" });
      return;
    }
    // ADR 028: the design index (ADR 020) gives this mutation the stable target
    // it previously lacked, which is what the old out-of-scope row waited on.
    // `job.designId` is only null for a session whose index write was lost.
    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      action: AUDIT_ACTIONS.designSessionCancelled,
      targetType: "design",
      targetId: job.designId,
      metadata: { slug: job.designSlug, sessionId: job.id },
    });
    res.status(200).json({});
  });

  // Force-cancels a feature. Flips the feature straight to `cancelled`
  // synchronously (not waiting on the Orchestrator to round-trip a
  // `run_cancelled` event the way job-level cancellation used to) so it
  // can never get stuck mid-cancel, then best-effort cancels whatever job
  // is currently outstanding for it — the Orchestrator picks that up via
  // Postgres LISTEN/NOTIFY on 'job_cancellations' as before. `cancelled`
  // is excluded from every project/repo-deletion blocking check, so this
  // is how a stuck feature gets "cleaned up" for deletion purposes.
  router.post("/:projectId/features/:featureId/cancel", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const featureId = parseFeatureId(routeParam(req.params.featureId));
    if (!featureId) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const cancelled = await deps.features.cancel(featureId);
    if (!cancelled) {
      res.status(409).json({ error: "Feature cannot be cancelled from its current state" });
      return;
    }

    await deps.jobs.cancelActiveForFeature(featureId);

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.featureCancelled,
      targetType: "feature",
      targetId: featureId,
      metadata: { title: cancelled.title },
    });

    res.status(200).json(toPublicFeature(cancelled));
  });

  // Restarts a cancelled feature: re-enters `draft` (same reset
  // retry-grill does for a failed feature) and kicks off a fresh
  // spec_grill run from scratch.
  router.post(
    "/:projectId/features/:featureId/restart",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const featureId = parseFeatureId(routeParam(req.params.featureId));
      if (!featureId) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const modelConfigError = await assertModelConfigResolvable(project, "spec_grill", featureId);
      if (modelConfigError) {
        res.status(400).json({ error: modelConfigError });
        return;
      }

      const restarted = await deps.features.restartFromCancelled(featureId);
      if (!restarted) {
        res.status(409).json({ error: "Feature is not cancelled" });
        return;
      }

      await dispatchJob(deps.jobs, {
        projectId: project.id,
        kind: "spec_grill",
        featureId: restarted.id,
      });

      await deps.audit.record(res, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.featureRestarted,
        targetType: "feature",
        targetId: restarted.id,
        metadata: { title: restarted.title },
      });

      res.status(201).json(toPublicFeature(restarted));
    },
  );

  // Re-runs a failed feature's spec_grill session (originally added to
  // recover a project stuck in `initializing` whose project_init spec_grill
  // never had a resolvable model config to run against, ADR 007; widened to
  // any feature type per ADR 012's "generalize retry" follow-up —
  // resetForRetry and dispatchJob were already feature-type-agnostic, only
  // this guard was project_init-only).
  router.post(
    "/:projectId/features/:featureId/retry-grill",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const featureId = parseFeatureId(routeParam(req.params.featureId));
      if (!featureId) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const feature = await deps.features.findById(project.id, featureId);
      if (!feature) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      if (feature.status !== "draft" && feature.status !== "failed") {
        res.status(409).json({ error: "Feature is not in a retryable state" });
        return;
      }

      const activeJob = await deps.jobs.findActiveSpecGrillJob(featureId);
      if (activeJob) {
        res.status(409).json({ error: "A grill session is already running for this feature" });
        return;
      }

      const modelConfigError = await assertModelConfigResolvable(project, "spec_grill", feature.id);
      if (modelConfigError) {
        res.status(400).json({ error: modelConfigError });
        return;
      }

      await deps.features.resetForRetry(featureId);
      await dispatchJob(deps.jobs, {
        projectId: project.id,
        kind: "spec_grill",
        featureId: feature.id,
      });

      await deps.audit.record(res, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.featureGrillRetried,
        targetType: "feature",
        targetId: feature.id,
        metadata: { title: feature.title },
      });

      res.status(201).json({});
    },
  );

  // ADR 024: rewinds a feature's Spec interview to one transcript turn
  // ("restart from here").
  //
  // The feature re-enters `draft` and a NEW spec_grill run is dispatched —
  // ADR 012's precedent, a new job row every time, the old one kept as
  // history — seeded with the conversation *before* the chosen turn. This is
  // the only per-message control; "resume from here" is deliberately absent
  // because a live session is already steered by ADR 006's mid-run reply, and
  // this route refuses to run underneath one.
  router.post(
    "/:projectId/features/:featureId/restart-from-message",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const featureId = parseFeatureId(routeParam(req.params.featureId));
      if (!featureId) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const parsed = parseBody(restartFromMessageSchema, req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const feature = await deps.features.findById(project.id, featureId);
      if (!feature) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      // The transcript the user was reading is the feature's latest job's, so
      // the chosen turn must belong to *that* run — an id from an earlier run
      // of the same feature would seed a context whose surrounding turns are
      // not the ones on screen.
      const latestJob = await deps.jobs.findLatestJob(featureId);
      const activeJob = await deps.jobs.findActiveSpecGrillJob(featureId);
      const gate = {
        status: feature.status,
        latestJobKind: latestJob?.kind ?? null,
        hasActiveGrillJob: activeJob !== null,
      };
      if (!canRestartFromMessage(gate)) {
        res.status(409).json({ error: messageRestartRefusal(gate) });
        return;
      }

      const events = latestJob ? await deps.jobEvents.listByJob(latestJob.id) : [];
      const seed = buildGrillRestartSeed(events, parsed.data.eventId);
      if (!seed) {
        res.status(404).json({
          error: "That message is not part of the current grill transcript",
        });
        return;
      }

      const modelConfigError = await assertModelConfigResolvable(
        project,
        "spec_grill",
        feature.id,
      );
      if (modelConfigError) {
        res.status(400).json({ error: modelConfigError });
        return;
      }

      // Guarded on the allowed set, so a feature that moved on between the
      // checks above and here is refused rather than silently rewound.
      const rewound = await deps.features.resetForMessageRestart(
        featureId,
        MESSAGE_RESTART_STATUSES,
      );
      if (!rewound) {
        res.status(409).json({ error: "Feature is not in a restartable state" });
        return;
      }

      await dispatchJob(deps.jobs, {
        projectId: project.id,
        kind: "spec_grill",
        featureId: rewound.id,
        specContext: seed,
        restartedFromEventId: parsed.data.eventId,
      });

      await deps.audit.record(res, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.featureGrillRestartedFromMessage,
        targetType: "feature",
        targetId: rewound.id,
        // The turn is the whole point of this action — without it the row says
        // a grill was rewound but not how far.
        metadata: { title: rewound.title, restartedFromEventId: parsed.data.eventId },
      });

      res.status(201).json(toPublicFeature(rewound));
    },
  );

  // Re-dispatches a feature_build job for a feature whose build failed,
  // keeping the already-approved ADR intact (features.retryBuild) instead
  // of re-running the interview like retry-grill does — the counterpart to
  // that endpoint for the build phase, not scoped to project_init since any
  // feature's build can fail. adrApproved is what distinguishes "this
  // feature failed during build" from "this feature failed during
  // spec_grill" for a feature sitting in 'failed' either way.
  router.post(
    "/:projectId/features/:featureId/retry-build",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const featureId = parseFeatureId(routeParam(req.params.featureId));
      if (!featureId) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const feature = await deps.features.findById(project.id, featureId);
      if (!feature) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      if (feature.status !== "failed" || !feature.adrApproved) {
        res.status(409).json({ error: "Feature is not in a retryable build state" });
        return;
      }

      const latestJob = await deps.jobs.findLatestJob(featureId);
      if (latestJob && (latestJob.status === "pending" || latestJob.status === "running")) {
        res.status(409).json({ error: "A build is already running for this feature" });
        return;
      }

      const accessError = assertGitHubAccess(project);
      if (accessError) {
        res.status(409).json({ error: accessError });
        return;
      }

      const modelConfigError = await assertModelConfigResolvable(project, "feature_build", feature.id);
      if (modelConfigError) {
        res.status(400).json({ error: modelConfigError });
        return;
      }

      const updated = await deps.features.retryBuild(featureId);
      if (!updated) {
        res.status(409).json({ error: "Unable to retry build" });
        return;
      }

      await dispatchJob(deps.jobs, {
        projectId: project.id,
        kind: "feature_build",
        featureId: updated.id,
      });

      await deps.audit.record(res, {
        organizationId: project.organizationId,
        projectId: project.id,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.featureBuildRetried,
        targetType: "feature",
        targetId: updated.id,
        metadata: { title: updated.title },
      });

      res.status(201).json({});
    },
  );

  // --- Feature Action Items (ADR 015 items 4-6) ---

  router.get("/:projectId/features/:featureId/action-items", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const featureId = parseFeatureId(routeParam(req.params.featureId));
    if (!featureId) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const items = await deps.actionItems.listForFeature(featureId);
    const projectSecrets = await deps.secrets.decryptAllForProject(project.id);
    for (const item of items) {
      if (
        item.status === "open" &&
        item.type === "secret_request" &&
        item.secretKey &&
        Object.prototype.hasOwnProperty.call(projectSecrets, item.secretKey)
      ) {
        await deps.actionItems.resolve(item.id);
        item.status = "resolved";
      }
    }
    res.json(items.map(toPublicActionItem));
  });

  // Human-supervised resolution (ADR 015 item 5): the caller confirms a
  // target is met (e.g. a blocking subtask reached merged, a test was
  // created) — the mechanical auto-resolution paths (secret polling etc.)
  // happen server-side alongside job dispatch.
  router.post(
    "/:projectId/features/:featureId/action-items/:itemId/resolve",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const featureId = parseFeatureId(routeParam(req.params.featureId));
      const itemId = routeParam(req.params.itemId);
      if (!featureId || !isUuid(itemId)) {
        res.status(404).json({ error: "Action item not found" });
        return;
      }
      const item = await deps.actionItems.findById(featureId, itemId);
      if (!item) {
        res.status(404).json({ error: "Action item not found" });
        return;
      }
      if (item.type === "design_grill") {
        res.status(409).json({ error: "Design Action Items resolve when the design is submitted" });
        return;
      }
      await deps.actionItems.resolve(itemId);
      res.status(200).json({ ok: true });
    },
  );

  // Test requests are the one synchronous Action Item mechanic: the human
  // edits the proposed markdown and chooses its schedule, then the real Test
  // entity is created immediately (ADR 015 item 5).
  router.post(
    "/:projectId/features/:featureId/action-items/:itemId/test",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const featureId = parseFeatureId(routeParam(req.params.featureId));
      const itemId = routeParam(req.params.itemId);
      if (!featureId || !isUuid(itemId)) {
        res.status(404).json({ error: "Action item not found" });
        return;
      }
      const item = await deps.actionItems.findById(featureId, itemId);
      if (!item || item.type !== "test_request" || item.status !== "open") {
        res.status(400).json({ error: "Test Action Item is not available" });
        return;
      }
      const parsed = parseBody(
        z.object({
          name: z.string().trim().min(1).max(256),
          specMarkdown: z.string().trim().min(1).optional(),
          scheduleCron: z.string().trim().min(1),
        }),
        req.body,
      );
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      if (!isValidCronExpression(parsed.data.scheduleCron) ||
          !meetsMinimumInterval(parsed.data.scheduleCron)) {
        res.status(400).json({ error: "Schedule must be a valid expression with an interval of at least one hour" });
        return;
      }
      const test = await deps.tests.create({
        projectId: project.id,
        name: parsed.data.name,
        specMarkdown: parsed.data.specMarkdown ?? item.draftTestMarkdown ?? item.description,
        scheduleCron: parsed.data.scheduleCron,
        enabled: true,
      });
      await deps.actionItems.resolve(item.id);
      res.status(201).json(toPublicTest(test));
    },
  );

  // ADR 015 item 5: env-var/secret requests auto-resolve by polling whether
  // the named key now exists in project_secrets — no manual "mark resolved"
  // step. The Web page calls this (or a server-side job-site hook does) to
  // sweep the feature's open secret_request items.
  router.post(
    "/:projectId/features/:featureId/action-items/auto-resolve",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const featureId = parseFeatureId(routeParam(req.params.featureId));
      if (!featureId) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }
      const items = await deps.actionItems.listForFeature(featureId);
      const projectSecrets = await deps.secrets.decryptAllForProject(project.id);
      let resolved = 0;
      for (const item of items) {
        if (item.status === "open" && item.type === "secret_request" && item.secretKey) {
          if (Object.prototype.hasOwnProperty.call(projectSecrets, item.secretKey)) {
            await deps.actionItems.resolve(item.id);
            resolved += 1;
          }
        }
      }
      res.status(200).json({ resolved, remainingOpen: await deps.actionItems.countOpenForFeature(featureId) });
    },
  );

  // ADR 015 item 5: "new blocking subtask feature" — auto-creates a real,
  // parented Feature that runs the normal full lifecycle. The parent's
  // Action Item resolves only when the subtask reaches `merged` (handled in
  // the PR-merge webhook path, github/webhook-routes.ts).
  router.post(
    "/:projectId/features/:featureId/action-items/:itemId/subtask",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const featureId = parseFeatureId(routeParam(req.params.featureId));
      const itemId = routeParam(req.params.itemId);
      if (!featureId || !isUuid(itemId)) {
        res.status(404).json({ error: "Action item not found" });
        return;
      }
      const item = await deps.actionItems.findById(featureId, itemId);
      if (!item || item.type !== "subtask_feature") {
        res.status(400).json({ error: "Item is not a subtask-feature action item" });
        return;
      }
      if (item.subtaskFeatureId) {
        const existing = await deps.features.findById(project.id, item.subtaskFeatureId);
        if (existing) {
          res.status(200).json(toPublicFeature(existing));
          return;
        }
      }
      const parsed = z.object({ title: z.string().trim().min(1).max(256) }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
        return;
      }
      const subtask = await deps.features.createSubtask({
        projectId: project.id,
        parentFeatureId: featureId,
        title: parsed.data.title,
      });
      res.status(201).json(toPublicFeature(subtask));
    },
  );

  // ADR 015 item 18: `returned` requires an explicit human "Resume
  // implementation" click to redispatch feature_build (landing back in
  // `queued`). No unattended auto-retry.
  router.post("/:projectId/features/:featureId/resume", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const featureId = parseFeatureId(routeParam(req.params.featureId));
    if (!featureId) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const accessError = assertGitHubAccess(project);
    if (accessError) {
      res.status(409).json({ error: accessError });
      return;
    }
    const modelConfigError = await assertModelConfigResolvable(project, "feature_build", featureId);
    if (modelConfigError) {
      res.status(400).json({ error: modelConfigError });
      return;
    }

    const updated = await deps.features.resumeImplementation(featureId);
    if (!updated) {
      res.status(409).json({ error: "Feature is not in a resumable state" });
      return;
    }

    await dispatchJob(deps.jobs, {
      projectId: project.id,
      kind: "feature_build",
      featureId: updated.id,
    });

    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.featureResumed,
      targetType: "feature",
      targetId: updated.id,
      metadata: { title: updated.title, returnReason: updated.returnReason },
    });
    res.status(201).json(toPublicFeature(updated));
  });

  // Reads a feature's most recent job's curated event history (ADR 006
  // item 8's read side, widened to feature_build by ADR 010) — the Web app
  // polls this to render/refresh the live grill conversation and, once a
  // build is dispatched, build progress/result, since WebSocket relay is
  // still not built. jobStatus lets the Web app tell an in-progress run
  // apart from one that finished, failed, or was cancelled, without a
  // second request.
  router.get("/:projectId/features/:featureId/events", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const featureId = parseFeatureId(routeParam(req.params.featureId));
    if (!featureId) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const feature = await deps.features.findById(project.id, featureId);
    if (!feature) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const job = await deps.jobs.findLatestJob(featureId);
    if (!job) {
      res.json({
        jobStatus: null,
        lastError: null,
        jobKind: null,
        restartedFromEventId: null,
        // Issue #92: present exactly when a human owes an answer, so this mirrors
        // the no-job case honestly — a feature with no job is waiting on nothing.
        awaitingReply: null,
        events: [],
      });
      return;
    }

    const events = await deps.jobEvents.listByJob(job.id);
    // jobKind lets the caller tell whether this transcript is a grill at all
    // (ADR 024's per-message restart only applies to one);
    // restartedFromEventId says this run is a rewind of an earlier one, so the
    // page can explain why its transcript starts mid-conversation.
    res.json({
      jobStatus: job.status,
      lastError: job.lastError,
      jobKind: job.kind,
      /*
       * ADR 032 item 1: the latest job's own id, so a client can address its
       * artifacts.
       *
       * This response already describes that job -- its kind, its status, and
       * whether it came from a rewind -- so its id is the same generation of
       * information rather than a new kind of thing, and it is the one field a
       * client cannot derive: every artifact route is job-scoped (`jobs/:jobId/…`),
       * and a page that holds only a feature id cannot build one. Without it the
       * Spec page cannot ask whether this run's session was saved, which is what ADR
       * 032 item 5 requires a user to be told.
       *
       * Null when the feature has no job at all, matching `jobStatus`.
       */
      jobId: job.id,
      restartedFromEventId: job.restartedFromEventId,
      /**
       * Issue #92: how long this grill has been waiting on an unanswered
       * question, or null when it is not waiting.
       *
       * **On this read rather than the feature read, deliberately.** The age is
       * derived from these events (`jobs/grill-wait.ts`), and this endpoint is the
       * one the grill surface already polls, so putting it here means a client
       * needs no second call and the number travels beside its own evidence. The
       * feature read keeps owning `awaitingUserInput`, which is the boolean the
       * rest of the app gates on — this is the *when*, not a second answer to
       * *whether*.
       */
      awaitingReply: deriveAwaitingReply({
        awaitingUserInput: feature.awaitingUserInput,
        events,
        timeoutMs: config.grills.replyTimeoutMs,
        timeoutSource: config.grills.replyTimeoutSource,
      }),
      events,
    });
  });

  // ADR 024 item 8 / issue #28 part 2: a **specific** run's curated event history,
  // by job id — so a superseded run's transcript can be read back.
  //
  // The sibling route above resolves its job as `findLatestJob(featureId)`: one job,
  // the newest. That is what a live surface wants, and it is also why a rewound
  // conversation was unreachable — the earlier run still exists, but no route would
  // ever hand it over. This is that route.
  //
  // `jobKind` and `jobStatus` are returned for the same reason the sibling returns
  // them: the reader needs to know whether the transcript it got is a grill at all,
  // and whether the run ended. `awaitingReply` is deliberately absent — it answers
  // "is a human being waited on right now", which is a property of the *current*
  // run; this read exists for runs that have been left behind.
  router.get(
    "/:projectId/features/:featureId/jobs/:jobId/events",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const featureId = parseFeatureId(routeParam(req.params.featureId));
      if (!featureId) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const feature = await deps.features.findById(project.id, featureId);
      if (!feature) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const jobId = routeParam(req.params.jobId);
      if (!isUuid(jobId)) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const job = await deps.jobs.findByIdForProject(project.id, jobId);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      /*
       * The extra assertion this route needs, and the reason it is not optional.
       *
       * `findByIdForProject` binds a job to a *project*, so on its own it would let a
       * caller read any job in the project by pasting its uuid into a path that names
       * an unrelated feature — and a grill transcript is the whole prior conversation,
       * including anything a human typed into it. Requiring the job's own `featureId`
       * to be the requested one closes that: the path's two ids must agree with each
       * other and with the row.
       *
       * 404 rather than 403, matching the sibling route's treatment of "not reachable
       * through this path": a caller who may read the project but not this job should
       * not be told whether the job exists.
       */
      if (job.featureId !== featureId) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const events = await deps.jobEvents.listByJob(job.id);
      res.json({
        jobStatus: job.status,
        lastError: job.lastError,
        jobKind: job.kind,
        restartedFromEventId: job.restartedFromEventId,
        events,
      });
    },
  );

  // ADR 024 item 8 / issue #28 part 2: the feature's **earlier** grill runs, so the
  // Spec page can offer what a rewind discarded.
  //
  // Returns earlier runs *only*, and says so in the response key rather than leaving
  // a client to drop the last element itself. "Which run is current" is a rule the
  // API owns — `earlierGrillRuns` applies it, and the sibling `/events` route already
  // answers the current run — so a client that filtered this array would be
  // re-implementing a rule, which is how the readiness predicate came to be derived
  // in the browser twice (#35/#89).
  //
  // Ordering, what counts as earlier, and which run superseded which all live in
  // `jobs/grill-runs.ts`, where they are unit-tested as rules rather than asserted
  // through HTTP.
  router.get(
    "/:projectId/features/:featureId/grill-runs",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const featureId = parseFeatureId(routeParam(req.params.featureId));
      if (!featureId) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const feature = await deps.features.findById(project.id, featureId);
      if (!feature) {
        res.status(404).json({ error: "Feature not found" });
        return;
      }

      const runs = await deps.jobs.listFeatureGrillRuns(featureId);
      res.json({ earlierRuns: earlierGrillRuns(runs) });
    },
  );

  router.get("/:projectId/tests", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const tests = await deps.tests.listByProject(project.id);
    res.json(tests.map(toPublicTest));
  });

  router.post("/:projectId/tests", requireAuth, async (req, res) => {
    const parsed = parseBody(createTestSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    if (!isValidCronExpression(parsed.data.scheduleCron)) {
      res.status(400).json({ error: "Invalid cron expression" });
      return;
    }

    if (!meetsMinimumInterval(parsed.data.scheduleCron)) {
      res.status(400).json({ error: "Minimum test interval is 1 hour" });
      return;
    }

    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.status !== "ready") {
      res.status(409).json({
        error: "Project initialization must complete before defining tests",
      });
      return;
    }

    const test = await deps.tests.create({
      projectId: project.id,
      name: parsed.data.name,
      specMarkdown: parsed.data.specMarkdown,
      scheduleCron: parsed.data.scheduleCron,
      enabled: parsed.data.enabled,
    });

    res.status(201).json(toPublicTest(test));
  });

  router.get("/:projectId/tests/:testId", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const testId = parseFeatureId(routeParam(req.params.testId));
    if (!testId) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const test = await deps.tests.findById(project.id, testId);
    if (!test) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    res.json(toPublicTest(test));
  });

  router.patch("/:projectId/tests/:testId", requireAuth, async (req, res) => {
    const parsed = parseBody(updateTestSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    if (parsed.data.scheduleCron !== undefined) {
      if (!isValidCronExpression(parsed.data.scheduleCron)) {
        res.status(400).json({ error: "Invalid cron expression" });
        return;
      }
      if (!meetsMinimumInterval(parsed.data.scheduleCron)) {
        res.status(400).json({ error: "Minimum test interval is 1 hour" });
        return;
      }
    }

    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const testId = parseFeatureId(routeParam(req.params.testId));
    if (!testId) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const existing = await deps.tests.findById(project.id, testId);
    if (!existing) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const test = await deps.tests.update(testId, parsed.data);
    if (!test) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    res.json(toPublicTest(test));
  });

  /*
   * Issue #31 (ADR 026 follow-up 4): dispatch this test now, without waiting for
   * its schedule.
   *
   * Why it exists: a suite can otherwise only be triggered by its cron, so a user
   * who fixes a failing test waits up to a full interval to find out whether the
   * fix worked — for a daily schedule, that is a day per attempt. ADR 026 skipped
   * this deliberately, because a new mutating endpoint means new authorization
   * surface and an ADR 028 audit row, and both are below.
   *
   * **Authorization is the project-membership gate**, exactly like the CRUD routes
   * beside it, not a new capability: a member who may edit a test's schedule and
   * delete the test may certainly run it. (The `role_capabilities` matrix is still
   * not wired into enforcement anywhere, so inventing a `test_run` capability here
   * would create a permission nothing reads — ADR 018 item 7's precedent.)
   *
   * **The dispatch is identical to the scheduler's** — same kind, same
   * `ref: "main"`, no feature — because a manual run verifies the same thing a
   * scheduled one does: the project's default branch. `trigger: "manual"` is the
   * only difference, and it is what keeps the run history honest (see migration
   * 049).
   */
  router.post("/:projectId/tests/:testId/run", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const testId = parseFeatureId(routeParam(req.params.testId));
    if (!testId) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const test = await deps.tests.findById(project.id, testId);
    if (!test) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    // The same gate the CRUD routes apply, for the same reason: a run needs a
    // cluster and a resolvable model, and dispatching against a project that has
    // neither would queue a job that cannot start. `POST /:projectId/tests`
    // refuses on the same condition.
    if (project.status !== "ready") {
      res.status(409).json({
        error: "Project initialization must complete before running tests",
      });
      return;
    }

    // One run of a test at a time, so a double-clicked button cannot enqueue two
    // identical runs. 409 rather than a silent no-op: the caller asked for
    // something that did not happen, and a 201 would claim it did.
    if (await deps.jobs.hasActiveRunForTest(test.id)) {
      res.status(409).json({ error: "This test already has a run in progress" });
      return;
    }

    const job = await dispatchJob(deps.jobs, {
      projectId: project.id,
      kind: "test_run",
      testId: test.id,
      ref: "main",
      trigger: "manual",
    });

    // Unlike the scheduled dispatch, this one is audited (ADR 028): the schedule
    // has no actor to name and would add a row per window, whereas a manual run
    // happened because a person decided it should. `testId` and the job id are
    // both recorded — the first is what the actor acted on, the second is how to
    // find the run they produced.
    await deps.audit.record(res, {
      organizationId: project.organizationId,
      projectId: project.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.testRunTriggered,
      targetType: "test",
      targetId: test.id,
      metadata: { name: test.name, jobId: job.id, ref: "main" },
    });

    res.status(201).json({ jobId: job.id });
  });

  // ADR 026 (issue #16): a Test entity's own run history — the standalone
  // Testing product's view, as opposed to ADR 015's per-feature Testing tab
  // (`GET /:projectId/features/:featureId/testing`, below), which answers
  // "did this feature's branch pass before review". Both read the same reports;
  // they differ in what they are grouped by and what they show around them.
  //
  // Read-only, so no audit event (ADR 028 records mutations; read-auditing is
  // explicitly out of its scope), and the same project-access gate as every
  // other project read.
  router.get("/:projectId/tests/:testId/runs", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const testId = parseFeatureId(routeParam(req.params.testId));
    if (!testId) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    // Resolved through the project first, so another project's test id is a
    // 404 rather than a readable history.
    const test = await deps.tests.findById(project.id, testId);
    if (!test) {
      res.status(404).json({ error: "Test not found" });
      return;
    }

    const limit = historyLimit(req.query.limit);
    const runs = await deps.testRunReports.listRunsForTest(test.id, limit);

    res.json({
      testId: test.id,
      runs: runs.map(toPublicTestRunHistoryEntry),
    });
  });

  router.get(
    "/:projectId/tests/:testId/runs/:jobId",
    requireAuth,
    async (req, res) => {
      const project = await getOwnedProject(req, routeParam(req.params.projectId));
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const testId = parseFeatureId(routeParam(req.params.testId));
      if (!testId) {
        res.status(404).json({ error: "Test not found" });
        return;
      }

      const test = await deps.tests.findById(project.id, testId);
      if (!test) {
        res.status(404).json({ error: "Test not found" });
        return;
      }

      const jobId = parseFeatureId(routeParam(req.params.jobId));
      if (!jobId) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      const run = await deps.testRunReports.findRunForTest(test.id, jobId);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }

      res.json(toPublicTestRunHistoryEntry(run));
    },
  );

  return router;
}
