import { randomBytes } from "node:crypto";
import type pg from "pg";
import { uniqueSlug } from "../shared/slug.js";
import { isUuid } from "../shared/uuid.js";
import type {
  Organization,
  OrganizationInvite,
  OrganizationMembership,
  OrganizationStatus,
  OrgMember,
  OrgRole,
  RoleCapability,
} from "./types.js";

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  is_personal: boolean;
  status: OrganizationStatus;
  created_at: Date;
  updated_at: Date;
}

interface MembershipRow {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrgRole;
  created_at: Date;
  updated_at: Date;
}

interface InviteRow {
  id: string;
  organization_id: string;
  token: string;
  role: OrgRole;
  created_by_user_id: string;
  created_at: Date;
}

interface RoleCapabilityRow {
  role: OrgRole;
  capability: RoleCapability["capability"];
  level: RoleCapability["level"];
}

interface MemberRow {
  user_id: string;
  username: string;
  display_name: string;
  github_login: string;
  role: OrgRole;
}

const organizationColumns = `
  id, name, slug, description, is_personal, status, created_at, updated_at
`;

const membershipColumns = `
  id, organization_id, user_id, role, created_at, updated_at
`;

function mapOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isPersonal: row.is_personal,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMembership(row: MembershipRow): OrganizationMembership {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInvite(row: InviteRow): OrganizationInvite {
  return {
    id: row.id,
    organizationId: row.organization_id,
    token: row.token,
    role: row.role,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
  };
}

export class OrganizationRepository {
  constructor(private readonly db: pg.Pool) {}

  async findById(organizationId: string): Promise<Organization | null> {
    const result = await this.db.query<OrganizationRow>(
      `SELECT ${organizationColumns} FROM organizations WHERE id = $1`,
      [organizationId],
    );
    return result.rows[0] ? mapOrganization(result.rows[0]) : null;
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    const result = await this.db.query<OrganizationRow>(
      `SELECT ${organizationColumns} FROM organizations WHERE slug = $1`,
      [slug],
    );
    return result.rows[0] ? mapOrganization(result.rows[0]) : null;
  }

  async findPersonalByUser(userId: string): Promise<Organization | null> {
    const result = await this.db.query<OrganizationRow>(
      `SELECT o.${organizationColumns}
       FROM organizations o
       JOIN organization_memberships m ON m.organization_id = o.id
       WHERE m.user_id = $1 AND o.is_personal = TRUE
       LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? mapOrganization(result.rows[0]) : null;
  }

  async listForUser(userId: string): Promise<Organization[]> {
    const result = await this.db.query<OrganizationRow>(
      `SELECT o.${organizationColumns}
       FROM organizations o
       JOIN organization_memberships m ON m.organization_id = o.id
       WHERE m.user_id = $1
       ORDER BY o.is_personal DESC, o.name ASC`,
      [userId],
    );
    return result.rows.map(mapOrganization);
  }

  async memberCount(organizationId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM organization_memberships WHERE organization_id = $1`,
      [organizationId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Creates an organization and the initial admin membership in one transaction. */
  async create(input: {
    name: string;
    description: string;
    isPersonal: boolean;
    creatorUserId: string;
  }): Promise<Organization> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      const slug = await uniqueSlug(input.name, async (candidate) => {
        const existing = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM organizations WHERE slug = $1) AS exists`,
          [candidate],
        );
        return existing.rows[0]?.exists ?? false;
      });

      const orgResult = await client.query<OrganizationRow>(
        `INSERT INTO organizations (name, slug, description, is_personal)
         VALUES ($1, $2, $3, $4)
         RETURNING ${organizationColumns}`,
        [input.name, slug, input.description, input.isPersonal],
      );
      const org = mapOrganization(orgResult.rows[0]);

      await client.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'admin')`,
        [org.id, input.creatorUserId],
      );

      await client.query("COMMIT");
      return org;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async update(
    organizationId: string,
    input: { name?: string; description?: string },
  ): Promise<Organization | null> {
    const result = await this.db.query<OrganizationRow>(
      `UPDATE organizations
       SET name = COALESCE($2, name),
           description = COALESCE($3, description),
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${organizationColumns}`,
      [organizationId, input.name ?? null, input.description ?? null],
    );
    return result.rows[0] ? mapOrganization(result.rows[0]) : null;
  }

  async setStatus(
    organizationId: string,
    status: OrganizationStatus,
  ): Promise<Organization | null> {
    const result = await this.db.query<OrganizationRow>(
      `UPDATE organizations
       SET status = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING ${organizationColumns}`,
      [organizationId, status],
    );
    return result.rows[0] ? mapOrganization(result.rows[0]) : null;
  }

  async membership(organizationId: string, userId: string): Promise<OrganizationMembership | null> {
    const result = await this.db.query<MembershipRow>(
      `SELECT ${membershipColumns}
       FROM organization_memberships
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    return result.rows[0] ? mapMembership(result.rows[0]) : null;
  }

  async roleForUser(organizationId: string, userId: string): Promise<OrgRole | null> {
    const membership = await this.membership(organizationId, userId);
    return membership?.role ?? null;
  }

  async listMembers(organizationId: string): Promise<OrgMember[]> {
    const result = await this.db.query<MemberRow>(
      `SELECT m.user_id, u.username, u.display_name, u.github_login, m.role
       FROM organization_memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1
       ORDER BY (m.role = 'admin') DESC, u.display_name ASC`,
      [organizationId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      githubLogin: row.github_login,
      role: row.role,
    }));
  }

  /** Adds a member with the given role; a no-op (returns the existing role) if they already belong. */
  async addMember(
    organizationId: string,
    userId: string,
    role: OrgRole,
  ): Promise<OrgRole> {
    const result = await this.db.query<{ role: OrgRole }>(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO NOTHING
       RETURNING role`,
      [organizationId, userId, role],
    );
    if (result.rows[0]) {
      return result.rows[0].role;
    }
    const existing = await this.roleForUser(organizationId, userId);
    return existing ?? role;
  }

  async setRole(organizationId: string, userId: string, role: OrgRole): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE organization_memberships
       SET role = $3, updated_at = NOW()
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId, role],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async removeMember(organizationId: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM organization_memberships
       WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async countAdmins(organizationId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
       FROM organization_memberships
       WHERE organization_id = $1 AND role = 'admin'`,
      [organizationId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async createInvite(input: {
    organizationId: string;
    role: OrgRole;
    createdByUserId: string;
  }): Promise<OrganizationInvite> {
    const token = randomBytes(24).toString("hex");
    const result = await this.db.query<InviteRow>(
      `INSERT INTO organization_invites
         (organization_id, token, role, created_by_user_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, organization_id, token, role, created_by_user_id, created_at`,
      [input.organizationId, token, input.role, input.createdByUserId],
    );
    return mapInvite(result.rows[0]);
  }

  async listInvites(organizationId: string): Promise<OrganizationInvite[]> {
    const result = await this.db.query<InviteRow>(
      `SELECT id, organization_id, token, role, created_by_user_id, created_at
       FROM organization_invites
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [organizationId],
    );
    return result.rows.map(mapInvite);
  }

  async revokeInvite(organizationId: string, inviteId: string): Promise<boolean> {
    if (!isUuid(inviteId)) {
      return false;
    }
    const result = await this.db.query(
      `DELETE FROM organization_invites
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, inviteId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async findByInviteToken(token: string): Promise<OrganizationInvite | null> {
    const result = await this.db.query<InviteRow>(
      `SELECT id, organization_id, token, role, created_by_user_id, created_at
       FROM organization_invites
       WHERE token = $1`,
      [token],
    );
    return result.rows[0] ? mapInvite(result.rows[0]) : null;
  }

  async listRoleCapabilities(): Promise<RoleCapability[]> {
    const result = await this.db.query<RoleCapabilityRow>(
      `SELECT role, capability, level FROM role_capabilities ORDER BY role, capability`,
    );
    return result.rows.map((row) => ({
      role: row.role,
      capability: row.capability,
      level: row.level,
    }));
  }
}