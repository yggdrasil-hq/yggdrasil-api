import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import type { OrganizationRepository } from "../organizations/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import { slugify } from "../shared/slug.js";
import { AUDIT_ACTIONS } from "../audit/actions.js";
import type { AuditRecorder } from "../audit/record.js";
import { EXTENSION_LIMITS, validateExtensionBundle } from "./bundle.js";
import type { OrgExtensionRepository } from "./repository.js";
import { toPublicOrgExtension } from "./types.js";

/**
 * ADR 025: uploaded Pi extensions are an **organization-level** resource
 * because the trust decision is org-wide — an admin who installs code that
 * runs with the org's model key and every project's GitHub token is making
 * that call once, not per project. Individual projects then opt in separately
 * (see the projects router), which is the narrower of the two decisions.
 *
 * Every write here is admin-only, reusing the same `role !== "admin"` check
 * the org provider/cluster/secret routes use (ADR 016 item 11 / ADR 018 item
 * 7). Reads are admin-only too, unlike those surfaces: this list is the
 * inventory of what code can run with the org's credentials, and the detail
 * view serves source text.
 */

const uploadSchema = z.object({
  name: z.string().trim().min(1).max(128),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Slug must be lowercase alphanumeric with dashes")
    .max(96)
    .optional(),
  entryPath: z.string().min(1).max(EXTENSION_LIMITS.maxPathLength).optional(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(EXTENSION_LIMITS.maxPathLength),
        content: z.string(),
      }),
    )
    .min(1)
    .max(EXTENSION_LIMITS.maxFiles),
  /**
   * ADR 025 item 6: the client must state that the operator has been shown
   * and accepted the trust warning. Required rather than optional so an
   * upload cannot happen by an API path that never rendered the warning —
   * which is also why it is a literal `true` and not a boolean: `false` is a
   * refusal, and an absent field is a programming error in the caller.
   */
  acknowledgedRisk: z.literal(true),
});

const activationSchema = z.object({ active: z.boolean() });

export function createOrgExtensionsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  organizations: OrganizationRepository;
  extensions: OrgExtensionRepository;
  audit: AuditRecorder;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  type AuthedReq = Parameters<typeof requireAuth>[0];

  function orgIdParam(req: AuthedReq): string | null {
    const value = routeParam(req.params.organizationId);
    return isUuid(value) ? value : null;
  }

  /**
   * Admin-only, and 404 (not 403) for a non-member — matching the other org
   * surfaces, so an unauthorized caller cannot probe which org ids exist.
   */
  async function requireOrgAdmin(req: AuthedReq, res: Parameters<typeof requireAuth>[1]) {
    const orgId = orgIdParam(req);
    if (!orgId) {
      res.status(404).json({ error: "Organization not found" });
      return null;
    }
    const role = await deps.organizations.roleForUser(orgId, req.currentUser!.id);
    if (!role) {
      res.status(404).json({ error: "Organization not found" });
      return null;
    }
    if (role !== "admin") {
      res.status(403).json({ error: "Admin role required" });
      return null;
    }
    return orgId;
  }

  router.get("/:organizationId/extensions", requireAuth, async (req, res) => {
    const orgId = await requireOrgAdmin(req, res);
    if (!orgId) return;
    const extensions = await deps.extensions.listForOrganization(orgId);
    res.json({ extensions: extensions.map(toPublicOrgExtension) });
  });

  router.get("/:organizationId/extensions/:extensionId", requireAuth, async (req, res) => {
    const orgId = await requireOrgAdmin(req, res);
    if (!orgId) return;

    const extensionId = routeParam(req.params.extensionId);
    if (!isUuid(extensionId)) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }
    const extension = await deps.extensions.findById(extensionId);
    // Scoped to the org in the path, so an id from another org is 404 rather
    // than readable by any admin of any org.
    if (!extension || extension.organizationId !== orgId) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }

    const [files, enabledProjects] = await Promise.all([
      deps.extensions.listFiles(extensionId),
      deps.extensions.listEnabledProjects(orgId),
    ]);

    res.json({
      extension: {
        ...toPublicOrgExtension({
          ...extension,
          uploadedByUsername: null,
          uploadedByDisplayName: null,
          enabledProjectCount: enabledProjects.length,
        }),
        // The source is served here so a second admin can read what is
        // actually installed before trusting it — the only real control this
        // feature has. Rendered as text by the Web app, never as HTML.
        files,
        enabledProjects,
      },
    });
  });

  router.post("/:organizationId/extensions", requireAuth, async (req, res) => {
    const orgId = await requireOrgAdmin(req, res);
    if (!orgId) return;

    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const bundleResult = validateExtensionBundle({
      entryPath: parsed.data.entryPath,
      files: parsed.data.files,
    });
    if (!bundleResult.ok) {
      res.status(400).json({ error: bundleResult.error });
      return;
    }
    const bundle = bundleResult.bundle;

    const slug = parsed.data.slug ?? slugify(parsed.data.name);
    if (!slug) {
      res.status(400).json({ error: "Name must contain at least one alphanumeric character" });
      return;
    }

    // The cap applies to *new* extensions only: replacing an existing one is
    // a revision of something already counted, and counting it again would
    // make the cap a trap once an org reached it.
    const existing = await deps.extensions.listForOrganization(orgId);
    const isNew = !existing.some((extension) => extension.slug === slug);
    if (isNew && existing.length >= EXTENSION_LIMITS.maxPerOrganization) {
      res.status(400).json({
        error: `An organization may store at most ${EXTENSION_LIMITS.maxPerOrganization} extensions; remove one first`,
      });
      return;
    }

    const saved = await deps.extensions.createOrReplace({
      organizationId: orgId,
      slug,
      name: parsed.data.name,
      uploadedByUserId: req.currentUser!.id,
      bundle,
    });

    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.extensionUploaded,
      targetType: "org_extension",
      targetId: saved.id,
      // Digest and shape, never the source: the trail is broadly readable and
      // kept forever, and uploaded code can contain an embedded key.
      metadata: {
        slug: saved.slug,
        name: saved.name,
        entryPath: saved.entryPath,
        fileCount: bundle.files.length,
        totalBytes: bundle.totalBytes,
        sourceSha256: saved.sourceSha256,
        replaced: !isNew,
      },
    });

    res.status(201).json({
      extension: {
        ...toPublicOrgExtension({
          ...saved,
          uploadedByUsername: null,
          uploadedByDisplayName: null,
          enabledProjectCount: 0,
        }),
        files: bundle.files.map((file) => ({
          path: file.path,
          content: file.content,
          sizeBytes: file.sizeBytes,
        })),
        enabledProjects: [],
      },
    });
  });

  router.patch("/:organizationId/extensions/:extensionId", requireAuth, async (req, res) => {
    const orgId = await requireOrgAdmin(req, res);
    if (!orgId) return;

    const extensionId = routeParam(req.params.extensionId);
    if (!isUuid(extensionId)) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }
    const extension = await deps.extensions.findById(extensionId);
    if (!extension || extension.organizationId !== orgId) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }

    const parsed = activationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "active must be a boolean" });
      return;
    }

    await deps.extensions.setActive(extensionId, parsed.data.active);

    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.extensionActivationChanged,
      targetType: "org_extension",
      targetId: extensionId,
      metadata: { slug: extension.slug, active: parsed.data.active },
    });

    const refreshed = await deps.extensions.findById(extensionId);
    res.json({
      extension: toPublicOrgExtension({
        ...(refreshed ?? extension),
        uploadedByUsername: null,
        uploadedByDisplayName: null,
        enabledProjectCount: 0,
      }),
    });
  });

  router.delete("/:organizationId/extensions/:extensionId", requireAuth, async (req, res) => {
    const orgId = await requireOrgAdmin(req, res);
    if (!orgId) return;

    const extensionId = routeParam(req.params.extensionId);
    if (!isUuid(extensionId)) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }
    const extension = await deps.extensions.findById(extensionId);
    if (!extension || extension.organizationId !== orgId) {
      res.status(404).json({ error: "Extension not found" });
      return;
    }

    await deps.extensions.remove(extensionId);

    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.extensionDeleted,
      targetType: "org_extension",
      targetId: extensionId,
      metadata: { slug: extension.slug, sourceSha256: extension.sourceSha256 },
    });

    res.status(204).end();
  });

  return router;
}
