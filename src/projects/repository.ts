import type pg from "pg";
import { slugify, uniqueSlug } from "../shared/slug.js";
import type { Project, ProjectRepositoryRecord, ProjectStatus } from "./types.js";

interface ProjectRow {
  id: string;
  owner_user_id: string;
  name: string;
  slug: string;
  description: string;
  status: ProjectStatus;
  settings: Record<string, unknown>;
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
  id, owner_user_id, name, slug, description, status, settings, created_at, updated_at
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
    ownerUserId: row.owner_user_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    settings: row.settings ?? {},
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

  async findByIdForUser(projectId: string, userId: string): Promise<Project | null> {
    const result = await this.db.query<ProjectRow>(
      `SELECT ${projectColumns}
       FROM projects
       WHERE id = $1 AND owner_user_id = $2`,
      [projectId, userId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const repositories = await this.loadRepositories(row.id);
    return mapProject(row, repositories);
  }

  async listForUser(userId: string): Promise<Project[]> {
    const result = await this.db.query<ProjectRow>(
      `SELECT ${projectColumns}
       FROM projects
       WHERE owner_user_id = $1
       ORDER BY updated_at DESC`,
      [userId],
    );

    const projects: Project[] = [];
    for (const row of result.rows) {
      const repositories = await this.loadRepositories(row.id);
      projects.push(mapProject(row, repositories));
    }
    return projects;
  }

  async create(input: {
    ownerUserId: string;
    name: string;
    description: string;
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
             SELECT 1 FROM projects WHERE owner_user_id = $1 AND slug = $2
           ) AS exists`,
          [input.ownerUserId, candidate],
        );
        return existing.rows[0]?.exists ?? false;
      });

      const projectResult = await client.query<ProjectRow>(
        `INSERT INTO projects (owner_user_id, name, slug, description, status)
         VALUES ($1, $2, $3, $4, 'initializing')
         RETURNING ${projectColumns}`,
        [input.ownerUserId, input.name, slug, input.description],
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

  async isSlugTaken(ownerUserId: string, slug: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM projects WHERE owner_user_id = $1 AND slug = $2
       ) AS exists`,
      [ownerUserId, slug],
    );
    return result.rows[0]?.exists ?? false;
  }

  static slugifyTitle(title: string): string {
    return slugify(title);
  }
}
