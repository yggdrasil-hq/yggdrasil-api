import type pg from "pg";
import { slugify, uniqueSlug } from "../shared/slug.js";
import type { Project, ProjectRepositoryRecord, ProjectStatus } from "./types.js";

interface ProjectRow {
  id: string;
  organization_id: string;
  owner_user_id: string;
  name: string;
  slug: string;
  description: string;
  status: ProjectStatus;
  settings: Record<string, unknown>;
  installation_id: string | null;
  github_access_warning: boolean;
  model_config_warning: boolean;
  agentic_review_enabled: boolean;
  has_design_surface: boolean;
  created_at: Date;
  updated_at: Date;
}

interface RepositoryRow {
  id: string;
  project_id: string;
  github_owner: string;
  github_repo: string;
  is_primary: boolean;
  sort_order: number;
}

const projectColumns = `
  id, organization_id, owner_user_id, name, slug, description, status, settings,
  installation_id, github_access_warning, model_config_warning,
  agentic_review_enabled, has_design_surface, created_at, updated_at
`;

function mapRepository(row: RepositoryRow): ProjectRepositoryRecord {
  return {
    id: row.id,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    isPrimary: row.is_primary,
    sortOrder: row.sort_order,
  };
}

function mapProject(row: ProjectRow, repositories: ProjectRepositoryRecord[]): Project {
  return {
    id: row.id,
    organizationId: row.organization_id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    settings: row.settings ?? {},
    installationId: row.installation_id,
    githubAccessWarning: row.github_access_warning,
    modelConfigWarning: row.model_config_warning,
    agenticReviewEnabled: row.agentic_review_enabled,
    hasDesignSurface: row.has_design_surface,
    repositories,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepository {
  constructor(private readonly db: pg.Pool) {}

  private async loadRepositories(projectId: string): Promise<ProjectRepositoryRecord[]> {
    const result = await this.db.query<RepositoryRow>(
      `SELECT id, project_id, github_owner, github_repo, is_primary, sort_order
       FROM project_repositories
       WHERE project_id = $1
       ORDER BY sort_order ASC`,
      [projectId],
    );
    return result.rows.map(mapRepository);
  }

  /** No owner scoping — internal (non-session) callers only, e.g. the Orchestrator's chart fetch. */
  async findById(projectId: string): Promise<Project | null> {
    const result = await this.db.query<ProjectRow>(
      `SELECT ${projectColumns}
       FROM projects
       WHERE id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const repositories = await this.loadRepositories(row.id);
    return mapProject(row, repositories);
  }

  /** The organization that owns a project — used to route per-org config/cluster resolution. */
  async findOrganizationId(projectId: string): Promise<string | null> {
    const result = await this.db.query<{ organization_id: string }>(
      `SELECT organization_id FROM projects WHERE id = $1`,
      [projectId],
    );
    return result.rows[0]?.organization_id ?? null;
  }

  /**
   * Finds a project the given user can access, resolved through their org
   * membership (org-scoped ownership, ADR 016 items 4 & 6). Returns null if
   * the user belongs to the project's org but isn't a member of it.
   */
  async findByIdForUser(projectId: string, userId: string): Promise<Project | null> {
    const result = await this.db.query<ProjectRow>(
      `SELECT p.${projectColumns}
       FROM projects p
       JOIN organization_memberships m ON m.organization_id = p.organization_id
       WHERE p.id = $1 AND m.user_id = $2`,
      [projectId, userId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const repositories = await this.loadRepositories(row.id);
    return mapProject(row, repositories);
  }

  /** Lists every project across all orgs the user belongs to (org-scoped, ADR 016). */
  async listForUser(userId: string): Promise<Project[]> {
    const result = await this.db.query<ProjectRow>(
      `SELECT DISTINCT p.${projectColumns}
       FROM projects p
       JOIN organization_memberships m ON m.organization_id = p.organization_id
       WHERE m.user_id = $1
       ORDER BY p.updated_at DESC`,
      [userId],
    );

    const projects: Project[] = [];
    for (const row of result.rows) {
      const repositories = await this.loadRepositories(row.id);
      projects.push(mapProject(row, repositories));
    }
    return projects;
  }

  /** Lists projects owned by a single org (used to gate project creation on org readiness). */
  async listForOrganization(organizationId: string): Promise<Project[]> {
    const result = await this.db.query<ProjectRow>(
      `SELECT ${projectColumns}
       FROM projects
       WHERE organization_id = $1
       ORDER BY updated_at DESC`,
      [organizationId],
    );
    const projects: Project[] = [];
    for (const row of result.rows) {
      const repositories = await this.loadRepositories(row.id);
      projects.push(mapProject(row, repositories));
    }
    return projects;
  }

  async create(input: {
    organizationId: string;
    ownerUserId: string;
    name: string;
    description: string;
    installationId: string;
    repositories: Array<{
      githubOwner: string;
      githubRepo: string;
      isPrimary: boolean;
    }>;
  }): Promise<Project> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");

      const slug = await uniqueSlug(input.name, async (candidate) => {
        const existing = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM projects WHERE organization_id = $1 AND slug = $2
           ) AS exists`,
          [input.organizationId, candidate],
        );
        return existing.rows[0]?.exists ?? false;
      });

      const projectResult = await client.query<ProjectRow>(
        `INSERT INTO projects (organization_id, owner_user_id, name, slug, description, status, installation_id)
         VALUES ($1, $2, $3, $4, $5, 'initializing', $6)
         RETURNING ${projectColumns}`,
        [
          input.organizationId,
          input.ownerUserId,
          input.name,
          slug,
          input.description,
          input.installationId,
        ],
      );
      const projectRow = projectResult.rows[0];

      const repositories: ProjectRepositoryRecord[] = [];
      for (const [index, repo] of input.repositories.entries()) {
        const repoResult = await client.query<RepositoryRow>(
          `INSERT INTO project_repositories
             (project_id, github_owner, github_repo, is_primary, sort_order)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, project_id, github_owner, github_repo, is_primary, sort_order`,
          [
            projectRow.id,
            repo.githubOwner,
            repo.githubRepo,
            repo.isPrimary,
            index,
          ],
        );
        repositories.push(mapRepository(repoResult.rows[0]));
      }

      await client.query("COMMIT");
      return mapProject(projectRow, repositories);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markReady(projectId: string): Promise<void> {
    await this.db.query(
      `UPDATE projects SET status = 'ready', updated_at = NOW() WHERE id = $1`,
      [projectId],
    );
  }

  /** Set when a dispatch site can't resolve a model configuration for this project (ADR 007). */
  async setModelConfigWarning(projectId: string): Promise<void> {
    await this.db.query(
      `UPDATE projects SET model_config_warning = TRUE, updated_at = NOW() WHERE id = $1`,
      [projectId],
    );
  }

  /** Clear a project's model-config warning the next time resolution succeeds (ADR 016). */
  async clearModelConfigWarning(projectId: string): Promise<void> {
    await this.db.query(
      `UPDATE projects SET model_config_warning = FALSE, updated_at = NOW() WHERE id = $1`,
      [projectId],
    );
  }

  /** ADR 015 item 12: per-project Agentic Review gate. */
  async setAgenticReviewEnabled(projectId: string, enabled: boolean): Promise<void> {
    await this.db.query(
      `UPDATE projects SET agentic_review_enabled = $2, updated_at = NOW() WHERE id = $1`,
      [projectId, enabled],
    );
  }

  /** ADR 014: records the project-init interview's UI/design-surface answer. */
  async setHasDesignSurface(projectId: string, hasDesignSurface: boolean): Promise<void> {
    await this.db.query(
      `UPDATE projects SET has_design_surface = $2, updated_at = NOW() WHERE id = $1`,
      [projectId, hasDesignSurface],
    );
  }

  async addSubRepository(
    projectId: string,
    input: { githubOwner: string; githubRepo: string },
  ): Promise<ProjectRepositoryRecord | null> {
    const projectResult = await this.db.query<{ id: string }>(
      `SELECT id FROM projects WHERE id = $1`,
      [projectId],
    );
    if (!projectResult.rows[0]) {
      return null;
    }

    const owner = input.githubOwner.trim();
    const repo = input.githubRepo.trim();
    const normalizedOwner = owner.toLowerCase();
    const normalizedRepo = repo.toLowerCase();

    const existing = await this.db.query<RepositoryRow>(
      `SELECT id, project_id, github_owner, github_repo, is_primary, sort_order
       FROM project_repositories
       WHERE project_id = $1
         AND LOWER(github_owner) = $2
         AND LOWER(github_repo) = $3`,
      [projectId, normalizedOwner, normalizedRepo],
    );
    if (existing.rows[0]) {
      throw new Error("Repository is already linked to this project");
    }

    const sortOrderResult = await this.db.query<{ next_order: number }>(
      `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
       FROM project_repositories
       WHERE project_id = $1`,
      [projectId],
    );
    const sortOrder = sortOrderResult.rows[0]?.next_order ?? 0;

    const repoResult = await this.db.query<RepositoryRow>(
      `INSERT INTO project_repositories
         (project_id, github_owner, github_repo, is_primary, sort_order)
       VALUES ($1, $2, $3, FALSE, $4)
       RETURNING id, project_id, github_owner, github_repo, is_primary, sort_order`,
      [projectId, owner, repo, sortOrder],
    );

    await this.db.query(
      `UPDATE projects SET updated_at = NOW() WHERE id = $1`,
      [projectId],
    );

    return mapRepository(repoResult.rows[0]);
  }

  async deleteSubRepository(
    projectId: string,
    repositoryId: string,
  ): Promise<"not_found" | "primary" | "deleted"> {
    const existing = await this.db.query<{ is_primary: boolean }>(
      `SELECT is_primary FROM project_repositories
       WHERE project_id = $1 AND id = $2`,
      [projectId, repositoryId],
    );

    if (!existing.rows[0]) {
      return "not_found";
    }

    if (existing.rows[0].is_primary) {
      return "primary";
    }

    await this.db.query(
      `DELETE FROM project_repositories WHERE project_id = $1 AND id = $2`,
      [projectId, repositoryId],
    );

    await this.db.query(
      `UPDATE projects SET updated_at = NOW() WHERE id = $1`,
      [projectId],
    );

    return "deleted";
  }

  async findByPrimaryRepository(
    githubOwner: string,
    githubRepo: string,
  ): Promise<{ id: string; status: ProjectStatus } | null> {
    const normalizedOwner = githubOwner.trim().toLowerCase();
    const normalizedRepo = githubRepo.trim().toLowerCase();

    const result = await this.db.query<{ id: string; status: ProjectStatus }>(
      `SELECT p.id, p.status
       FROM projects p
       JOIN project_repositories r ON r.project_id = p.id
       WHERE r.is_primary = TRUE
         AND LOWER(r.github_owner) = $1
         AND LOWER(r.github_repo) = $2`,
      [normalizedOwner, normalizedRepo],
    );
    return result.rows[0] ?? null;
  }

  matchesPrimaryRepository(
    project: Project,
    githubOwner: string,
    githubRepo: string,
  ): boolean {
    const primary = project.repositories.find((repo) => repo.isPrimary);
    if (!primary) {
      return false;
    }
    return (
      primary.githubOwner.toLowerCase() === githubOwner.trim().toLowerCase() &&
      primary.githubRepo.toLowerCase() === githubRepo.trim().toLowerCase()
    );
  }

  async isSlugTaken(organizationId: string, slug: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM projects WHERE organization_id = $1 AND slug = $2
       ) AS exists`,
      [organizationId, slug],
    );
    return result.rows[0]?.exists ?? false;
  }

  static slugifyTitle(title: string): string {
    return slugify(title);
  }
}
