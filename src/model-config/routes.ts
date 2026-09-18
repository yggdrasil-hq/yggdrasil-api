import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import type { OrganizationRepository } from "../organizations/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { OrgProviderRepository } from "./provider-repository.js";
import type { OrgModelRepository } from "./model-repository.js";
import type { JobModelDefaultRepository } from "./job-default-repository.js";
import { AGENT_JOB_KINDS, DEFAULT_PROVIDER_BASE_URLS, PROVIDER_TYPES } from "./types.js";
import type { AgentJobKind, ProviderType } from "./types.js";
import {
  listProviderModels,
  testProviderConnection,
} from "./provider-client.js";
import { AUDIT_ACTIONS } from "../audit/actions.js";
import type { AuditRecorder } from "../audit/record.js";

const jobKindSchema = z.enum(AGENT_JOB_KINDS);

const createProviderSchema = z.object({
  name: z.string().trim().min(1).max(128),
  providerType: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1),
});

const updateProviderSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  baseUrl: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1).optional(),
});

const probeModelsSchema = z.object({
  /** Optional: a custom triplet has no provider declaration, and defaults to OpenAI-compatible. */
  providerType: z.enum(PROVIDER_TYPES).optional(),
  baseUrl: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
});

const testProviderSchema = z.object({
  providerType: z.enum(PROVIDER_TYPES),
  baseUrl: z.string().trim().min(1).optional(),
  apiKey: z.string().trim().min(1),
});

const createModelSchema = z.object({
  providerId: z.string().uuid(),
  displayName: z.string().trim().min(1).max(128),
  modelId: z.string().trim().min(1).max(256),
});

const updateModelSchema = z.object({
  displayName: z.string().trim().min(1).max(128).optional(),
  modelId: z.string().trim().min(1).max(256).optional(),
});

const setJobDefaultSchema = z.object({
  modelId: z.string().uuid(),
});

function resolveBaseUrl(providerType: ProviderType, provided?: string): string | null {
  if (provided) return provided;
  if (providerType === "custom_openai_compatible") return null;
  return DEFAULT_PROVIDER_BASE_URLS[providerType];
}

/**
 * ADR 018: org-scoped providers, model catalog, and per-job-kind defaults.
 * Reads open to any org member; writes admin-only, mirroring the org-secrets
 * routes' `role !== "admin"` gate.
 */
export function createModelConfigRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  organizations: OrganizationRepository;
  providers: OrgProviderRepository;
  models: OrgModelRepository;
  jobDefaults: JobModelDefaultRepository;
  audit: AuditRecorder;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  type AuthedReq = Parameters<typeof requireAuth>[0];

  function orgIdParam(req: AuthedReq): string | null {
    const value = routeParam(req.params.organizationId);
    return isUuid(value) ? value : null;
  }

  async function roleInOrg(orgId: string, userId: string) {
    return deps.organizations.roleForUser(orgId, userId);
  }

  // --- Providers ---

  router.get("/:organizationId/providers", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (!role) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const providers = await deps.providers.listForOrganization(orgId);
    res.json(providers);
  });

  router.post("/:organizationId/providers", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const parsed = createProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const baseUrl = resolveBaseUrl(parsed.data.providerType, parsed.data.baseUrl);
    if (!baseUrl) {
      res.status(400).json({ error: "baseUrl is required for a custom provider" });
      return;
    }
    const provider = await deps.providers.create({
      organizationId: orgId,
      name: parsed.data.name,
      providerType: parsed.data.providerType,
      baseUrl,
      apiKey: parsed.data.apiKey,
    });
    // Provider name/type only — the API key is a credential (ADR 028 item 5).
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.modelProviderCreated,
      targetType: "model_provider",
      targetId: provider.id,
      metadata: { name: provider.name, providerType: provider.providerType },
    });
    res.status(201).json(provider);
  });

  router.put("/:organizationId/providers/:providerId", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const providerId = routeParam(req.params.providerId);
    if (!isUuid(providerId)) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    const parsed = updateProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const provider = await deps.providers.update(orgId, providerId, parsed.data);
    if (!provider) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.modelProviderUpdated,
      targetType: "model_provider",
      targetId: provider.id,
      metadata: { name: provider.name },
    });
    res.json(provider);
  });

  router.post("/:organizationId/providers/test-connection", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const parsed = testProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const baseUrl = resolveBaseUrl(parsed.data.providerType, parsed.data.baseUrl);
    if (!baseUrl) {
      res.status(400).json({ error: "baseUrl is required for a custom provider" });
      return;
    }
    const result = await testProviderConnection({
      providerType: parsed.data.providerType,
      baseUrl,
      apiKey: parsed.data.apiKey,
    });
    res.status(200).json(result);
  });

  router.post("/:organizationId/providers/:providerId/test-connection", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const providerId = routeParam(req.params.providerId);
    if (!isUuid(providerId)) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    const provider = await deps.providers.findById(orgId, providerId);
    if (!provider) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    const apiKey = await deps.providers.decryptApiKey(providerId);
    if (!apiKey) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    const result = await testProviderConnection({
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      apiKey,
    });
    res.status(200).json(result);
  });

  /*
   * ADR 018 / issue #36: the models a configured provider serves, so adding a
   * catalog model is a choice from what the provider actually offers rather than
   * a hand-typed identifier that fails later as a broken job.
   *
   * Admin-only, exactly like the other provider calls: this spends the org's
   * provider credential, so a readonly member must not be able to use it to
   * probe a key they cannot see.
   *
   * The listing is *not* persisted. It is the provider's current answer, and a
   * cached copy would be the thing that goes stale the moment a key is rotated
   * or revoked — the question an admin asks when they open this dialog.
   * Free text stays available in the UI, so a model the provider has not listed
   * (or has withdrawn) can still be added by hand.
   */
  router.get("/:organizationId/providers/:providerId/models", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const providerId = routeParam(req.params.providerId);
    if (!isUuid(providerId)) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    const provider = await deps.providers.findById(orgId, providerId);
    if (!provider) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    const apiKey = await deps.providers.decryptApiKey(providerId);
    if (!apiKey) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }

    const result = await listProviderModels({
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      apiKey,
    });

    if (!result.ok) {
      // 200 with `ok: false` rather than a 5xx: the request was fine, the
      // *provider* could not be listed, and the UI's job is to say why next to
      // the model field instead of showing an empty dropdown (#36).
      res.status(200).json({ ok: false, error: result.error });
      return;
    }

    res.status(200).json({
      ok: true,
      models: result.models,
      // The provider id the list belongs to, so a response that arrives after
      // the admin switched providers cannot populate the wrong field.
      providerId: provider.id,
    });
  });

  /*
   * Issue #36: the same listing for a connection that is *not* in the catalog —
   * the custom base URL + key triplet on a project or feature, where the admin
   * has typed a connection the org has not stored anywhere. There is no provider
   * row to read, so the credentials come from the body and are used for exactly
   * one request.
   *
   * Admin-gated like the stored-provider listing above, and for a second reason
   * beyond reading the org's key: this makes the server fetch a caller-supplied
   * URL, which the existing `POST /providers/test-connection` already allows an
   * org *admin* to do. Giving the same primitive to every org member would widen
   * that surface, and the benefit is small because the field keeps its free-text
   * fallback — nobody is blocked by the gate, they just type the id.
   *
   * `providerType` defaults to `custom_openai_compatible` because that is what a
   * custom triplet is: a base URL and a bearer key with no provider declaration
   * anywhere in the product.
   */
  router.post("/:organizationId/providers/probe-models", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const parsed = probeModelsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const result = await listProviderModels({
      providerType: parsed.data.providerType ?? "custom_openai_compatible",
      baseUrl: parsed.data.baseUrl,
      apiKey: parsed.data.apiKey,
    });

    if (!result.ok) {
      res.status(200).json({ ok: false, error: result.error });
      return;
    }
    res.status(200).json({ ok: true, models: result.models });
  });

  router.delete("/:organizationId/providers/:providerId", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const providerId = routeParam(req.params.providerId);
    if (!isUuid(providerId)) {
      res.status(404).json({ error: "Provider not found" });
      return;
    }
    try {
      const deleted = await deps.providers.delete(orgId, providerId);
      if (deleted) {
        await deps.audit.record(res, {
          organizationId: orgId,
          actorUserId: req.currentUser!.id,
          action: AUDIT_ACTIONS.modelProviderDeleted,
          targetType: "model_provider",
          targetId: providerId,
        });
      }
      res.status(deleted ? 204 : 404).send();
    } catch {
      res.status(409).json({ error: "Provider has models in its catalog — remove those first" });
    }
  });

  // --- Model catalog ---

  router.get("/:organizationId/models", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (!role) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const models = await deps.models.listForOrganization(orgId);
    res.json(models);
  });

  router.post("/:organizationId/models", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const parsed = createModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const provider = await deps.providers.findById(orgId, parsed.data.providerId);
    if (!provider) {
      res.status(400).json({ error: "Provider not found" });
      return;
    }
    const model = await deps.models.create({
      organizationId: orgId,
      providerId: parsed.data.providerId,
      displayName: parsed.data.displayName,
      modelId: parsed.data.modelId,
    });
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.modelCreated,
      targetType: "model",
      targetId: model.id,
      metadata: { displayName: model.displayName, modelId: model.modelId },
    });
    res.status(201).json(model);
  });

  router.put("/:organizationId/models/:modelId", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const modelId = routeParam(req.params.modelId);
    if (!isUuid(modelId)) {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    const parsed = updateModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const model = await deps.models.update(orgId, modelId, {
      displayName: parsed.data.displayName,
      modelIdValue: parsed.data.modelId,
    });
    if (!model) {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.modelUpdated,
      targetType: "model",
      targetId: model.id,
      metadata: { displayName: model.displayName },
    });
    res.json(model);
  });

  router.delete("/:organizationId/models/:modelId", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const modelId = routeParam(req.params.modelId);
    if (!isUuid(modelId)) {
      res.status(404).json({ error: "Model not found" });
      return;
    }
    try {
      const deleted = await deps.models.delete(orgId, modelId);
      if (deleted) {
        await deps.audit.record(res, {
          organizationId: orgId,
          actorUserId: req.currentUser!.id,
          action: AUDIT_ACTIONS.modelDeleted,
          targetType: "model",
          targetId: modelId,
        });
      }
      res.status(deleted ? 204 : 404).send();
    } catch {
      res.status(409).json({
        error: "Model is assigned as a job default or a project/feature override — unassign it first",
      });
    }
  });

  // --- Per-job-kind org defaults ---

  router.get("/:organizationId/job-model-defaults", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (!role) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const defaults = await deps.jobDefaults.listForOrganization(orgId);
    res.json(defaults);
  });

  router.put("/:organizationId/job-model-defaults/:jobKind", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const jobKindParsed = jobKindSchema.safeParse(req.params.jobKind);
    if (!jobKindParsed.success) {
      res.status(400).json({ error: "Invalid job kind" });
      return;
    }
    const parsed = setJobDefaultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const model = await deps.models.findById(orgId, parsed.data.modelId);
    if (!model) {
      res.status(400).json({ error: "Model not found" });
      return;
    }
    const jobDefault = await deps.jobDefaults.upsert(
      orgId,
      jobKindParsed.data as AgentJobKind,
      parsed.data.modelId,
    );
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.jobModelDefaultSet,
      targetType: "job_model_default",
      targetId: model.id,
      metadata: { jobKind: jobKindParsed.data, displayName: model.displayName },
    });
    res.status(200).json(jobDefault);
  });

  router.delete("/:organizationId/job-model-defaults/:jobKind", requireAuth, async (req, res) => {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const role = await roleInOrg(orgId, req.currentUser!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return;
    }
    const jobKindParsed = jobKindSchema.safeParse(req.params.jobKind);
    if (!jobKindParsed.success) {
      res.status(400).json({ error: "Invalid job kind" });
      return;
    }
    const cleared = await deps.jobDefaults.clear(orgId, jobKindParsed.data as AgentJobKind);
    if (cleared) {
      await deps.audit.record(res, {
        organizationId: orgId,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.jobModelDefaultCleared,
        targetType: "job_model_default",
        metadata: { jobKind: jobKindParsed.data },
      });
    }
    res.status(cleared ? 204 : 404).send();
  });

  return router;
}
