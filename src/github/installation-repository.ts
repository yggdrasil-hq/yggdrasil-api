import type pg from "pg";

export interface GithubInstallation {
  id: string;
  githubInstallationId: number;
  accountType: "Organization" | "User";
  accountLogin: string;
  accountId: number;
  installedByUserId: string | null;
  suspendedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GithubInstallationRepo {
  installationId: string;
  repoFullName: string;
  githubRepoId: number;
}

interface InstallationRow {
  id: string;
  github_installation_id: string;
  account_type: "Organization" | "User";
  account_login: string;
  account_id: string;
  installed_by_user_id: string | null;
  suspended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RepoRow {
  installation_id: string;
  repo_full_name: string;
  github_repo_id: string;
}

function mapInstallation(row: InstallationRow): GithubInstallation {
  return {
    id: row.id,
    githubInstallationId: Number(row.github_installation_id),
    accountType: row.account_type,
    accountLogin: row.account_login,
    accountId: Number(row.account_id),
    installedByUserId: row.installed_by_user_id,
    suspendedAt: row.suspended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GithubInstallationRepository {
  constructor(private readonly db: pg.Pool) {}

  async findById(id: string): Promise<GithubInstallation | null> {
    const result = await this.db.query<InstallationRow>(
      `SELECT id, github_installation_id, account_type, account_login, account_id,
              installed_by_user_id, suspended_at, created_at, updated_at
       FROM github_installations
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapInstallation(row) : null;
  }

  async findByGithubInstallationId(
    githubInstallationId: number,
  ): Promise<GithubInstallation | null> {
    const result = await this.db.query<InstallationRow>(
      `SELECT id, github_installation_id, account_type, account_login, account_id,
              installed_by_user_id, suspended_at, created_at, updated_at
       FROM github_installations
       WHERE github_installation_id = $1`,
      [githubInstallationId],
    );
    const row = result.rows[0];
    return row ? mapInstallation(row) : null;
  }

  async listAll(): Promise<GithubInstallation[]> {
    const result = await this.db.query<InstallationRow>(
      `SELECT id, github_installation_id, account_type, account_login, account_id,
              installed_by_user_id, suspended_at, created_at, updated_at
       FROM github_installations
       WHERE suspended_at IS NULL
       ORDER BY account_login ASC`,
    );
    return result.rows.map(mapInstallation);
  }

  /** Installations visible to a specific user (via `user_installation_access`), not the global list. */
  async listForUser(userId: string): Promise<GithubInstallation[]> {
    const result = await this.db.query<InstallationRow>(
      `SELECT gi.id, gi.github_installation_id, gi.account_type, gi.account_login, gi.account_id,
              gi.installed_by_user_id, gi.suspended_at, gi.created_at, gi.updated_at
       FROM github_installations gi
       JOIN user_installation_access uia ON uia.installation_id = gi.id
       WHERE uia.user_id = $1 AND gi.suspended_at IS NULL
       ORDER BY gi.account_login ASC`,
      [userId],
    );
    return result.rows.map(mapInstallation);
  }

  /** Repos across every installation this user can see, flattened for the project-creation picker. */
  async listRepositoriesForUser(
    userId: string,
  ): Promise<Array<GithubInstallationRepo & { accountLogin: string; accountType: "Organization" | "User" }>> {
    const result = await this.db.query<
      RepoRow & { account_login: string; account_type: "Organization" | "User" }
    >(
      `SELECT gir.installation_id, gir.repo_full_name, gir.github_repo_id,
              gi.account_login, gi.account_type
       FROM github_installation_repos gir
       JOIN github_installations gi ON gi.id = gir.installation_id
       JOIN user_installation_access uia ON uia.installation_id = gi.id
       WHERE uia.user_id = $1 AND gi.suspended_at IS NULL
       ORDER BY gi.account_login ASC, gir.repo_full_name ASC`,
      [userId],
    );
    return result.rows.map((row) => ({
      installationId: row.installation_id,
      repoFullName: row.repo_full_name,
      githubRepoId: Number(row.github_repo_id),
      accountLogin: row.account_login,
      accountType: row.account_type,
    }));
  }

  async hasAnyRepositories(installationId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM github_installation_repos WHERE installation_id = $1) AS exists`,
      [installationId],
    );
    return result.rows[0]?.exists ?? false;
  }

  async upsertFromGitHub(input: {
    githubInstallationId: number;
    accountType: "Organization" | "User";
    accountLogin: string;
    accountId: number;
    installedByUserId?: string | null;
    suspendedAt?: Date | null;
  }): Promise<GithubInstallation> {
    const result = await this.db.query<InstallationRow>(
      `INSERT INTO github_installations
         (github_installation_id, account_type, account_login, account_id,
          installed_by_user_id, suspended_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (github_installation_id) DO UPDATE SET
         account_type = EXCLUDED.account_type,
         account_login = EXCLUDED.account_login,
         account_id = EXCLUDED.account_id,
         installed_by_user_id = COALESCE(EXCLUDED.installed_by_user_id, github_installations.installed_by_user_id),
         suspended_at = EXCLUDED.suspended_at,
         updated_at = NOW()
       RETURNING id, github_installation_id, account_type, account_login, account_id,
                 installed_by_user_id, suspended_at, created_at, updated_at`,
      [
        input.githubInstallationId,
        input.accountType,
        input.accountLogin,
        input.accountId,
        input.installedByUserId ?? null,
        input.suspendedAt ?? null,
      ],
    );
    return mapInstallation(result.rows[0]);
  }

  async markSuspended(githubInstallationId: number): Promise<void> {
    await this.db.query(
      `UPDATE github_installations
       SET suspended_at = NOW(), updated_at = NOW()
       WHERE github_installation_id = $1`,
      [githubInstallationId],
    );
  }

  async markActive(githubInstallationId: number): Promise<void> {
    await this.db.query(
      `UPDATE github_installations
       SET suspended_at = NULL, updated_at = NOW()
       WHERE github_installation_id = $1`,
      [githubInstallationId],
    );
  }

  async syncRepositories(
    installationId: string,
    repos: Array<{ fullName: string; githubRepoId: number }>,
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM github_installation_repos WHERE installation_id = $1`,
        [installationId],
      );
      for (const repo of repos) {
        await client.query(
          `INSERT INTO github_installation_repos
             (installation_id, repo_full_name, github_repo_id)
           VALUES ($1, $2, $3)`,
          [installationId, repo.fullName, repo.githubRepoId],
        );
      }
      await client.query(
        `UPDATE github_installations SET updated_at = NOW() WHERE id = $1`,
        [installationId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listRepositories(installationId: string): Promise<GithubInstallationRepo[]> {
    const result = await this.db.query<RepoRow>(
      `SELECT installation_id, repo_full_name, github_repo_id
       FROM github_installation_repos
       WHERE installation_id = $1
       ORDER BY repo_full_name ASC`,
      [installationId],
    );
    return result.rows.map((row) => ({
      installationId: row.installation_id,
      repoFullName: row.repo_full_name,
      githubRepoId: Number(row.github_repo_id),
    }));
  }

  async hasRepository(installationId: string, repoFullName: string): Promise<boolean> {
    const normalized = repoFullName.toLowerCase();
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM github_installation_repos
         WHERE installation_id = $1 AND LOWER(repo_full_name) = $2
       ) AS exists`,
      [installationId, normalized],
    );
    return result.rows[0]?.exists ?? false;
  }

  async removeRepository(installationId: string, repoFullName: string): Promise<void> {
    await this.db.query(
      `DELETE FROM github_installation_repos
       WHERE installation_id = $1 AND LOWER(repo_full_name) = LOWER($2)`,
      [installationId, repoFullName],
    );
  }

  async setProjectsAccessWarningForInstallation(
    installationId: string,
    warning: boolean,
  ): Promise<void> {
    await this.db.query(
      `UPDATE projects
       SET github_access_warning = $2, updated_at = NOW()
       WHERE installation_id = $1`,
      [installationId, warning],
    );
  }

  async setProjectAccessWarningForRepo(
    installationId: string,
    repoFullName: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE projects
       SET github_access_warning = TRUE, updated_at = NOW()
       WHERE installation_id = $1
         AND id IN (
           SELECT project_id FROM project_repositories
           WHERE LOWER(github_owner || '/' || github_repo) = LOWER($2)
         )`,
      [installationId, repoFullName],
    );
  }

  async clearProjectAccessWarningsIfReposGranted(installationId: string): Promise<void> {
    await this.db.query(
      `UPDATE projects p
       SET github_access_warning = FALSE, updated_at = NOW()
       WHERE p.installation_id = $1
         AND p.github_access_warning = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM project_repositories pr
           WHERE pr.project_id = p.id
             AND NOT EXISTS (
               SELECT 1 FROM github_installation_repos gir
               WHERE gir.installation_id = p.installation_id
                 AND LOWER(gir.repo_full_name) = LOWER(pr.github_owner || '/' || pr.github_repo)
             )
         )`,
      [installationId],
    );
  }
}
