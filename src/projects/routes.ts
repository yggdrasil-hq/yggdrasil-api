import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { dispatchJob } from "../jobs/dispatch.js";
import type { JobRepository } from "../jobs/repository.js";
import type { JobEventRepository } from "../jobs/events-repository.js";
import type { JobMessageRepository } from "../jobs/messages-repository.js";
import type { NotificationRepository } from "../notifications/repository.js";
import { UserRepository } from "../users/repository.js";
import type { FeatureRepository } from "../features/repository.js";
import { toPublicFeature } from "../features/types.js";
import type { TestRepository } from "../tests/repository.js";
import {
  isValidCronExpression,
  meetsMinimumInterval,
  toPublicTest,
} from "../tests/types.js";
import { buildProjectOverview } from "./overview.js";
import { scaffoldChart } from "./chart-scaffold.js";
import type { ProjectRepository } from "./repository.js";
import { getRepositoryRemovalBlockedReason } from "./repository-removal.js";
import { toPublicProject } from "./types.js";
import type { Project } from "./types.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { GithubInstallationRepository } from "../github/installation-repository.js";

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

const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(2000).optional().default(""),
  installationId: z.string().uuid(),
  repositories: z.array(repositorySchema).min(1),
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

const addSubRepositorySchema = z.object({
  githubOwner: z.string().trim().min(1),
  githubRepo: z.string().trim().min(1),
});

export function createProjectsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  features: FeatureRepository;
  tests: TestRepository;
  jobs: JobRepository;
  jobEvents: JobEventRepository;
  jobMessages: JobMessageRepository;
  notifications: NotificationRepository;
  installations: GithubInstallationRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

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

    const project = await deps.projects.create({
      ownerUserId: user.id,
      name: parsed.data.name,
      description: parsed.data.description,
      installationId: parsed.data.installationId,
      repositories: parsed.data.repositories,
    });

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

    const updated = await deps.projects.findByIdForUser(project.id, req.currentUser!.id);
    if (!updated) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json(await toPublicProjectWithRemovalMeta(updated));
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
    }

    if (parsed.data.startBuild) {
      if (feature.status !== "spec_ready" || !feature.adrApproved) {
        res.status(409).json({ error: "Approve the ADR before starting build" });
        return;
      }

      const accessError = assertGitHubAccess(project);
      if (accessError) {
        res.status(409).json({ error: accessError });
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
    }

    res.json(toPublicFeature(feature));
  });

  // Queues a human's reply to a running spec_grill job's ask_user question
  // (ADR 006 items 9-10). The Orchestrator picks it up via Postgres
  // LISTEN/NOTIFY on 'job_replies', not by polling this endpoint or any
  // other — this route's only job is to persist the reply and notify.
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
    await deps.features.setAwaitingUserInput(featureId, false);
    res.status(201).json({});
  });

  // Cancels a running spec_grill job (ADR 006's cancel/abort follow-up).
  // The Orchestrator picks this up via Postgres LISTEN/NOTIFY on
  // 'job_cancellations' — this route's only job is to flip the job's status
  // and notify; the Orchestrator decides how to actually stop the session
  // (sending Pi an abort command if attached, then deleting the pod).
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

    const feature = await deps.features.findById(project.id, featureId);
    if (!feature) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const job = await deps.jobs.findActiveSpecGrillJob(featureId);
    if (!job) {
      res.status(409).json({ error: "No active grill session to cancel" });
      return;
    }

    const cancelled = await deps.jobs.cancel(job.id);
    if (!cancelled) {
      res.status(409).json({ error: "No active grill session to cancel" });
      return;
    }

    res.status(200).json({});
  });

  // Reads a spec_grill job's curated event history for a feature (ADR 006
  // item 8's read side) — the Web app polls this to render/refresh the
  // live grill conversation, since WebSocket relay is still not built.
  // jobStatus lets the Web app tell an in-progress grill apart from one
  // that finished, failed, or was cancelled, without a second request.
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

    const job = await deps.jobs.findLatestSpecGrillJob(featureId);
    if (!job) {
      res.json({ jobStatus: null, events: [] });
      return;
    }

    const events = await deps.jobEvents.listByJob(job.id);
    res.json({ jobStatus: job.status, events });
  });

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

  return router;
}
