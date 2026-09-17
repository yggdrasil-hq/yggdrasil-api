import { Router } from "express";
import { z } from "zod";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { OrganizationRepository } from "./repository.js";
import type { OrganizationClusterRepository } from "./cluster-repository.js";
import type { OrgSecretRepository } from "./org-secrets-repository.js";
import { ORG_ROLES, ROLE_DISPLAY_NAMES, toPublicOrganization } from "./types.js";
import type { OrgRole } from "./types.js";
import { testClusterConnection } from "./cluster-connection-test.js";
import { AUDIT_ACTIONS } from "../audit/actions.js";
import type { AuditRecorder } from "../audit/record.js";

const roleSchema = z.enum(ORG_ROLES);

const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(128),
  description: z.string().max(4000).default(""),
});

const updateOrgSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().max(4000).optional(),
});

const inviteSchema = z.object({
  role: roleSchema,
});

const changeRoleSchema = z.object({
  role: roleSchema,
});

export function createOrganizationsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  organizations: OrganizationRepository;
  clusters: OrganizationClusterRepository;
  orgSecrets: OrgSecretRepository;
  audit: AuditRecorder;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  type AuthedReq = Parameters<typeof requireAuth>[0];

  /** Loads a valid org id param, or null if it's not a UUID and can never match. */
  function orgIdParam(req: AuthedReq): string | null {
    const value = routeParam(req.params.organizationId);
    return isUuid(value) ? value : null;
  }

  /** Resolves the caller's membership role in an org, or null if they're not a member. */
  async function roleInOrg(orgId: string, userId: string): Promise<OrgRole | null> {
    return deps.organizations.roleForUser(orgId, userId);
  }

  router.get("/roles", requireAuth, async (_req, res) => {
    const capabilities = await deps.organizations.listRoleCapabilities();
    res.json({
      roles: ORG_ROLES,
      roleDisplayNames: ROLE_DISPLAY_NAMES,
      capabilities,
    });
  });

  router.get("/", requireAuth, async (req, res) => {
    const user = req.currentUser!;
    const orgs = await deps.organizations.listForUser(user.id);
    const result = await Promise.all(
      orgs.map(async (org) => {
        const role = await deps.organizations.roleForUser(org.id, user.id);
        return toPublicOrganization(org, role ?? "developer");
      }),
    );
    res.json(result);
  });

  router.post("/", requireAuth, async (req, res) => {
    const parsed = createOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const org = await deps.organizations.create({
      name: parsed.data.name,
      description: parsed.data.description,
      isPersonal: false,
      creatorUserId: req.currentUser!.id,
    });
    await deps.audit.record(res, {
      organizationId: org.id,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.orgCreated,
      targetType: "organization",
      targetId: org.id,
      metadata: { name: org.name, slug: org.slug },
    });
    res.status(201).json(toPublicOrganization(org, "admin"));
  });

  router.get("/:organizationId", requireAuth, async (req, res) => {
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
    const org = await deps.organizations.findById(orgId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    res.json(toPublicOrganization(org, role));
  });

  router.patch("/:organizationId", requireAuth, async (req, res) => {
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

    const parsed = updateOrgSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const org = await deps.organizations.update(orgId, parsed.data);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.orgUpdated,
      targetType: "organization",
      targetId: orgId,
      metadata: { name: org.name },
    });
    res.json(toPublicOrganization(org, role));
  });

  router.get("/:organizationId/members", requireAuth, async (req, res) => {
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
    const members = await deps.organizations.listMembers(orgId);
    res.json({ members });
  });

  router.patch("/:organizationId/members/:userId", requireAuth, async (req, res) => {
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

    const parsed = changeRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const targetUserId = routeParam(req.params.userId);
    if (!isUuid(targetUserId)) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    const isTargetAdmin = (await deps.organizations.roleForUser(orgId, targetUserId)) === "admin";
    if (isTargetAdmin && parsed.data.role !== "admin") {
      const adminCount = await deps.organizations.countAdmins(orgId);
      if (adminCount <= 1) {
        res.status(409).json({ error: "Organization must keep at least one Admin" });
        return;
      }
    }

    const updated = await deps.organizations.setRole(orgId, targetUserId, parsed.data.role);
    if (!updated) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.orgRoleChanged,
      targetType: "member",
      targetId: targetUserId,
      metadata: { role: parsed.data.role },
    });
    res.status(200).send();
  });

  router.delete("/:organizationId/members/:userId", requireAuth, async (req, res) => {
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

    const targetUserId = routeParam(req.params.userId);
    if (!isUuid(targetUserId)) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    if (targetUserId === req.currentUser!.id) {
      res.status(400).json({ error: "Admins cannot remove themselves" });
      return;
    }

    const isTargetAdmin = (await deps.organizations.roleForUser(orgId, targetUserId)) === "admin";
    if (isTargetAdmin) {
      const adminCount = await deps.organizations.countAdmins(orgId);
      if (adminCount <= 1) {
        res.status(409).json({ error: "Organization must keep at least one Admin" });
        return;
      }
    }

    const removed = await deps.organizations.removeMember(orgId, targetUserId);
    if (!removed) {
      res.status(404).json({ error: "Member not found" });
      return;
    }
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.orgMemberRemoved,
      targetType: "member",
      targetId: targetUserId,
    });
    res.status(204).send();
  });

  router.get("/:organizationId/invites", requireAuth, async (req, res) => {
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
    const invites = await deps.organizations.listInvites(orgId);
    res.json({ invites });
  });

  router.post("/:organizationId/invites", requireAuth, async (req, res) => {
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

    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const invite = await deps.organizations.createInvite({
      organizationId: orgId,
      role: parsed.data.role,
      createdByUserId: req.currentUser!.id,
    });
    // The invite token is the whole credential — it must not reach the trail.
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.orgInviteCreated,
      targetType: "invite",
      targetId: invite.id,
      metadata: { role: parsed.data.role },
    });
    res.status(201).json(invite);
  });

  router.delete("/:organizationId/invites/:inviteId", requireAuth, async (req, res) => {
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

    const inviteId = routeParam(req.params.inviteId);
    const revoked = await deps.organizations.revokeInvite(orgId, inviteId);
    if (!revoked) {
      res.status(404).json({ error: "Invite not found" });
      return;
    }
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.orgInviteRevoked,
      targetType: "invite",
      targetId: isUuid(inviteId) ? inviteId : null,
    });
    res.status(204).send();
  });

  // The invite-accept endpoint. The Web app drives the GitHub OAuth round-trip;
  // by the time it calls this, the caller is already authenticated. Whoever
  // opens the link and completes OAuth (new or existing account) is added to
  // the org with the invited role — idempotent if they already belong.
  router.post("/invites/:token/accept", requireAuth, async (req, res) => {
    const token = routeParam(req.params.token);
    const invite = await deps.organizations.findByInviteToken(token);
    if (!invite) {
      res.status(404).json({ error: "Invite not found or expired" });
      return;
    }

    const existing = await deps.organizations.roleForUser(invite.organizationId, req.currentUser!.id);
    const role =
      existing ?? (await deps.organizations.addMember(invite.organizationId, req.currentUser!.id, invite.role));

    const org = await deps.organizations.findById(invite.organizationId);
    if (!org) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    if (!existing) {
      await deps.audit.record(res, {
        organizationId: invite.organizationId,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.orgMemberJoined,
        targetType: "member",
        targetId: req.currentUser!.id,
        metadata: { role, via: "invite_link" },
      });
    }
    res.status(existing ? 200 : 201).json({ organization: toPublicOrganization(org, role) });
  });

  // --- Cluster configuration (ADR 016 items 11-13) ---
  // Whole-org granularity, no per-project override. Setting a cluster flips
  // the org pending_cluster -> ready, which is the hard gate project
  // creation enforces (A2).

  router.get("/:organizationId/cluster", requireAuth, async (req, res) => {
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
    const cluster = await deps.clusters.findMetadata(orgId);
    res.json({ cluster });
  });

  router.put("/:organizationId/cluster", requireAuth, async (req, res) => {
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

    const parsed = z
      .object({
        kubeconfig: z.string().min(1, "kubeconfig is required"),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const cluster = await deps.clusters.upsert(orgId, parsed.data.kubeconfig);
    await deps.organizations.setStatus(orgId, "ready");
    // Kubeconfig contents never reach the trail — only that a cluster was set.
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.orgClusterSet,
      targetType: "organization_cluster",
      targetId: cluster.id,
    });
    res.status(200).json({ cluster });
  });

  router.post("/:organizationId/cluster/test-connection", requireAuth, async (req, res) => {
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

    const parsed = z
      .object({
        kubeconfig: z.string().min(1).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }

    const kubeconfig = parsed.data.kubeconfig || (await deps.clusters.decryptKubeconfig(orgId));
    if (!kubeconfig) {
      res.status(400).json({ error: "No kubeconfig to test" });
      return;
    }

    const result = await testClusterConnection(kubeconfig);
    res.status(200).json(result);
  });

  router.delete("/:organizationId/cluster", requireAuth, async (req, res) => {
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

    const deleted = await deps.clusters.delete(orgId);
    if (deleted) {
      await deps.organizations.setStatus(orgId, "pending_cluster");
      await deps.audit.record(res, {
        organizationId: orgId,
        actorUserId: req.currentUser!.id,
        action: AUDIT_ACTIONS.orgClusterRemoved,
        targetType: "organization_cluster",
      });
    }
    res.status(deleted ? 204 : 404).send();
  });

  // --- Org-level provider/secret config (ADR 016 items 8-10) ---
  // The org's model-config triplet and generic secrets are the single
  // fallback tier below a project. Metadata routes never expose plaintext.

  router.get("/:organizationId/secrets", requireAuth, async (req, res) => {
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
    const secrets = await deps.orgSecrets.listForOrganization(orgId);
    res.json(secrets);
  });

  router.put("/:organizationId/secrets", requireAuth, async (req, res) => {
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
    const parsed = z
      .object({
        key: z.string().trim().min(1).max(128),
        value: z.string(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const secret = await deps.orgSecrets.upsert(orgId, parsed.data.key, parsed.data.value);
    // Key name only — every org admin can read this trail (ADR 028 item 5).
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.orgSecretSet,
      targetType: "organization_secret",
      targetId: secret.id,
      metadata: { key: parsed.data.key },
    });
    res.status(200).json(secret);
  });

  router.delete("/:organizationId/secrets/:secretId", requireAuth, async (req, res) => {
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
    const secretId = routeParam(req.params.secretId);
    if (!isUuid(secretId)) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    const deleted = await deps.orgSecrets.delete(orgId, secretId);
    if (!deleted) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    await deps.audit.record(res, {
      organizationId: orgId,
      actorUserId: req.currentUser!.id,
      action: AUDIT_ACTIONS.orgSecretDeleted,
      targetType: "organization_secret",
      targetId: secretId,
    });
    res.status(204).send();
  });

  return router;
}