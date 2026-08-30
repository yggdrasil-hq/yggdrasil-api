/**
 * ADR 016 (Track A1): Organization entity, org-wide roles and memberships,
 * token-based invites, and the adjustable role -> capability matrix.
 * The five roles and their (best-effort default) grants come verbatim from
 * the wireframe (design/settings/organization/members); grants are seed data
 * in `role_capabilities`, not hardcoded logic here.
 */

export const ORG_ROLES = [
  "admin",
  "developer",
  "designer",
  "product_manager",
  "tester",
] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_DISPLAY_NAMES: Record<OrgRole, string> = {
  admin: "Admin",
  developer: "Developer",
  designer: "Designer",
  product_manager: "Product Manager",
  tester: "Tester",
};

export const ORG_CAPABILITIES = [
  "org_settings",
  "manage_projects",
  "manage_features",
  "design_sessions",
  "manage_tests",
  "pr_review",
] as const;
export type OrgCapability = (typeof ORG_CAPABILITIES)[number];

export const CAPABILITY_DISPLAY_NAMES: Record<OrgCapability, string> = {
  org_settings: "Org settings — cluster, providers, members",
  manage_projects: "Create & configure projects",
  manage_features: "Features — create, grill, approve ADR, start build",
  design_sessions: "Design sessions",
  manage_tests: "Tests — create, manage, view reports",
  pr_review: "Pull request review",
};

export type CapabilityLevel = "full" | "partial" | "none";

export type OrganizationStatus = "pending_cluster" | "ready";

export interface Organization {
  id: string;
  name: string;
  slug: string;
  description: string;
  isPersonal: boolean;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationMembership {
  id: string;
  organizationId: string;
  userId: string;
  role: OrgRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrganizationInvite {
  id: string;
  organizationId: string;
  token: string;
  role: OrgRole;
  createdByUserId: string;
  createdAt: Date;
}

export interface RoleCapability {
  role: OrgRole;
  capability: OrgCapability;
  level: CapabilityLevel;
}

/** A membership joined with the member's user profile — what the Members page renders. */
export interface OrgMember {
  userId: string;
  username: string;
  displayName: string;
  githubLogin: string;
  role: OrgRole;
}

export interface PublicOrganization {
  id: string;
  name: string;
  slug: string;
  description: string;
  isPersonal: boolean;
  status: OrganizationStatus;
  role: OrgRole;
  createdAt: string;
  updatedAt: string;
}

/** The member's own role, baked into the org shape so clients don't need a second call. */
export interface PublicOrganizationWithRole extends PublicOrganization {
  role: OrgRole;
}

export function toPublicOrganization(
  org: Organization,
  role: OrgRole,
): PublicOrganizationWithRole {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    description: org.description,
    isPersonal: org.isPersonal,
    status: org.status,
    role,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
}