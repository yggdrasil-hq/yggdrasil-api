import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { dispatchJob } from "../jobs/dispatch.js";
import type { JobRepository } from "../jobs/repository.js";
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
import type { ProjectRepository } from "./repository.js";
import { toPublicProject } from "./types.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";

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

export function createProjectsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  features: FeatureRepository;
  tests: TestRepository;
  jobs: JobRepository;
  notifications: NotificationRepository;
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

  router.get("/", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    const projects = await deps.projects.listForUser(user.id);
    res.json(projects.map(toPublicProject));
  });

  router.post("/", requireAuth, async (req, res) => {
    const parsed = parseBody(createProjectSchema, req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const user = req.currentUser!;
    const project = await deps.projects.create({
      ownerUserId: user.id,
      name: parsed.data.name,
      description: parsed.data.description,
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

    res.status(201).json(toPublicProject(project));
  });

  router.get("/:projectId", requireAuth, async (req, res) => {
    const project = await getOwnedProject(req, routeParam(req.params.projectId));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.json(toPublicProject(project));
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

    res.json(toPublicProject(updated));
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
