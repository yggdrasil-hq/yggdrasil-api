import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import type { FeatureRepository } from "../features/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { FeatureJobModelOverrideRepository } from "./feature-override-repository.js";
import type { OrgModelRepository } from "./model-repository.js";
import type { FeatureModelSecretRepository } from "../secrets/feature-model-repository.js";
import { MODEL_CONFIG_KEYS, resolveModelConfigSource } from "../secrets/model-config.js";
import type { ModelConfigResolutionDeps } from "../secrets/model-config.js";
import { AGENT_JOB_KINDS, type AgentJobKind } from "./types.js";

const jobKindSchema = z.enum(AGENT_JOB_KINDS);

const setOverrideSchema = z.object({
  modelId: z.string().uuid(),
});

/**
 * ADR 018 amendment (issue #5), the feature tier's custom triplet. Deliberately
 * a whole-bundle write rather than the project tier's per-key PUT: the
 * all-or-nothing rule is then structurally enforced by the request shape
 * instead of depending on every writer setting all three keys. Mirrors
 * project-creation's `modelConfig` bundle input for the same reason.
 */
const setModelSecretsSchema = z.object({
  modelBaseUrl: z.string().trim().min(1),
  modelApiKey: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
});

/** A job kind's effective model configuration, as safe to show a user: the tier it came from, never its values. */
interface EffectiveJobModelConfig {
  jobKind: AgentJobKind;
  source: string;
  modelId: string | null;
  modelDisplayName: string | null;
  providerName: string | null;
}

/**
 * ADR 018 amendment (issue #5): per-feature model configuration — the narrowest
 * resolution tier, mirroring the project tier's routes one level down (both
 * mechanisms: a catalog pick per job kind, and a fully custom triplet).
 *
 * Authorization reuses the exact gate that guards project-level model
 * configuration today (model-config/project-routes.ts): project access via
 * ProjectRepository.findByIdForUser, plus — new here, since these routes are
 * nested under a feature — the feature must belong to that project. No new
 * capability is introduced, matching ADR 018 item 7's "reuse ADR 016's existing
 * enforcement" stance.
 */
export function createFeatureModelConfigRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  features: FeatureRepository;
  models: OrgModelRepository;
  featureOverrides: FeatureJobModelOverrideRepository;
  featureSecrets: FeatureModelSecretRepository;
  /** The project/org/org-default repositories the shared precedence ladder needs. */
  resolution: Omit<ModelConfigResolutionDeps, "featureOverrides" | "featureSecrets">;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  type AuthedReq = Parameters<typeof requireAuth>[0];

  /**
   * Resolves `:projectId`/`:featureId` to a pair the caller is allowed to act
   * on, or null (surfaced as a 404 — never revealing whether the project or the
   * feature is the missing/deleted one).
   */
  async function getOwnedFeature(req: AuthedReq, projectId: string, featureId: string) {
    if (!isUuid(projectId) || !isUuid(featureId)) {
      return null;
    }
    const user = req.currentUser;
    if (!user) return null;
    const project = await deps.projects.findByIdForUser(projectId, user.id);
    if (!project) return null;
    const feature = await deps.features.findById(project.id, featureId);
    if (!feature) return null;
    return { project, feature };
  }

  function params(req: AuthedReq) {
    return {
      projectId: routeParam(req.params.projectId),
      featureId: routeParam(req.params.featureId),
    };
  }

  const resolutionDeps = (): ModelConfigResolutionDeps => ({
    ...deps.resolution,
    featureOverrides: deps.featureOverrides,
    featureSecrets: deps.featureSecrets,
  });

  // --- Effective configuration (what each job kind actually resolves to) ---

  /**
   * The read that makes "inherit" unambiguous: for every agent job kind, which
   * tier wins and — when it's a catalog tier — the catalog model by name. The
   * feature page uses this to say "inherited from Acme Retail's default" or
   * "inherited from this project's override" instead of leaving the user to
   * guess. Values (MODEL_API_KEY in particular) are never part of the response.
   */
  router.get("/:projectId/features/:featureId/model-config", requireAuth, async (req, res) => {
    const { projectId, featureId } = params(req);
    const owned = await getOwnedFeature(req, projectId, featureId);
    if (!owned) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const { project, feature } = owned;

    const customSecrets = await deps.featureSecrets.listForFeature(feature.id);
    const jobKinds: EffectiveJobModelConfig[] = [];

    for (const jobKind of AGENT_JOB_KINDS) {
      const { source, modelId } = await resolveModelConfigSource(resolutionDeps(), {
        projectId: project.id,
        organizationId: project.organizationId,
        jobKind,
        featureId: feature.id,
      });
      const model = modelId ? await deps.models.findById(project.organizationId, modelId) : null;
      jobKinds.push({
        jobKind,
        source,
        modelId,
        modelDisplayName: model?.displayName ?? null,
        providerName: model?.providerName ?? null,
      });
    }

    res.json({
      customTripletSet: MODEL_CONFIG_KEYS.every((key) =>
        customSecrets.some((secret) => secret.key === key),
      ),
      jobKinds,
    });
  });

  // --- Catalog override, per job kind ---

  router.get("/:projectId/features/:featureId/job-model-overrides", requireAuth, async (req, res) => {
    const { projectId, featureId } = params(req);
    const owned = await getOwnedFeature(req, projectId, featureId);
    if (!owned) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const overrides = await deps.featureOverrides.listForFeature(owned.feature.id);
    res.json(overrides);
  });

  router.put("/:projectId/features/:featureId/job-model-overrides/:jobKind", requireAuth, async (req, res) => {
    const { projectId, featureId } = params(req);
    const owned = await getOwnedFeature(req, projectId, featureId);
    if (!owned) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const jobKindParsed = jobKindSchema.safeParse(req.params.jobKind);
    if (!jobKindParsed.success) {
      res.status(400).json({ error: "Invalid job kind" });
      return;
    }
    const parsed = setOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const model = await deps.models.findById(owned.project.organizationId, parsed.data.modelId);
    if (!model) {
      res.status(400).json({ error: "Model not found" });
      return;
    }
    const override = await deps.featureOverrides.upsert(
      owned.feature.id,
      jobKindParsed.data as AgentJobKind,
      parsed.data.modelId,
    );
    res.status(200).json(override);
  });

  router.delete("/:projectId/features/:featureId/job-model-overrides/:jobKind", requireAuth, async (req, res) => {
    const { projectId, featureId } = params(req);
    const owned = await getOwnedFeature(req, projectId, featureId);
    if (!owned) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const jobKindParsed = jobKindSchema.safeParse(req.params.jobKind);
    if (!jobKindParsed.success) {
      res.status(400).json({ error: "Invalid job kind" });
      return;
    }
    const cleared = await deps.featureOverrides.clear(
      owned.feature.id,
      jobKindParsed.data as AgentJobKind,
    );
    res.status(cleared ? 204 : 404).send();
  });

  // --- Custom triplet (all-or-nothing) ---

  router.get("/:projectId/features/:featureId/model-secrets", requireAuth, async (req, res) => {
    const { projectId, featureId } = params(req);
    const owned = await getOwnedFeature(req, projectId, featureId);
    if (!owned) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const secrets = await deps.featureSecrets.listForFeature(owned.feature.id);
    res.json(secrets);
  });

  router.put("/:projectId/features/:featureId/model-secrets", requireAuth, async (req, res) => {
    const parsed = setModelSecretsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error:
          "A custom model configuration needs all three values (base URL, API key, model ID) — partial triplets are not allowed",
      });
      return;
    }
    const { projectId, featureId } = params(req);
    const owned = await getOwnedFeature(req, projectId, featureId);
    if (!owned) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }

    const values: Record<(typeof MODEL_CONFIG_KEYS)[number], string> = {
      MODEL_BASE_URL: parsed.data.modelBaseUrl,
      MODEL_API_KEY: parsed.data.modelApiKey,
      MODEL_ID: parsed.data.modelId,
    };
    const written = [];
    for (const key of MODEL_CONFIG_KEYS) {
      written.push(await deps.featureSecrets.upsert(owned.feature.id, key, values[key]));
    }
    res.status(200).json(written);
  });

  router.delete("/:projectId/features/:featureId/model-secrets", requireAuth, async (req, res) => {
    const { projectId, featureId } = params(req);
    const owned = await getOwnedFeature(req, projectId, featureId);
    if (!owned) {
      res.status(404).json({ error: "Feature not found" });
      return;
    }
    const secrets = await deps.featureSecrets.listForFeature(owned.feature.id);
    for (const secret of secrets) {
      await deps.featureSecrets.delete(owned.feature.id, secret.id);
    }
    res.status(204).send();
  });

  return router;
}
