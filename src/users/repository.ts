import type pg from "pg";
import type { OnboardingState, User } from "./types.js";

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  onboarding_state: OnboardingState;
  github_id: string | null;
  github_login: string | null;
  created_at: Date;
  updated_at: Date;
}

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    onboardingState: row.onboarding_state,
    githubId: row.github_id,
    githubLogin: row.github_login,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const userColumns = `
  id, username, display_name, password_hash, onboarding_state,
  github_id, github_login, created_at, updated_at
`;

export class UserRepository {
  constructor(private readonly db: pg.Pool) {}

  async findById(id: string): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      `SELECT ${userColumns} FROM users WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async findByUsername(username: string): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      `SELECT ${userColumns} FROM users WHERE username = $1`,
      [username],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async findByGithubId(githubId: string): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      `SELECT ${userColumns} FROM users WHERE github_id = $1`,
      [githubId],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async isUsernameTaken(username: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM users WHERE username = $1) AS exists`,
      [username],
    );
    return result.rows[0]?.exists ?? false;
  }

  async createPasswordUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
  }): Promise<User> {
    const result = await this.db.query<UserRow>(
      `INSERT INTO users (username, display_name, password_hash, onboarding_state)
       VALUES ($1, $2, $3, 'active')
       RETURNING ${userColumns}`,
      [input.username, input.displayName, input.passwordHash],
    );
    return mapUser(result.rows[0]);
  }

  async createGithubUser(input: {
    username: string;
    displayName: string;
    githubId: string;
    githubLogin: string;
  }): Promise<User> {
    const result = await this.db.query<UserRow>(
      `INSERT INTO users (username, display_name, onboarding_state, github_id, github_login)
       VALUES ($1, $2, 'pending_username', $3, $4)
       RETURNING ${userColumns}`,
      [input.username, input.displayName, input.githubId, input.githubLogin],
    );
    return mapUser(result.rows[0]);
  }

  async confirmUsername(
    userId: string,
    username: string,
    displayName?: string,
  ): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      `UPDATE users
       SET username = $2,
           display_name = COALESCE($3, display_name),
           onboarding_state = 'active',
           updated_at = NOW()
       WHERE id = $1 AND onboarding_state = 'pending_username'
       RETURNING ${userColumns}`,
      [userId, username, displayName ?? null],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async updateDisplayName(userId: string, displayName: string): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      `UPDATE users SET display_name = $2, updated_at = NOW()
       WHERE id = $1 RETURNING ${userColumns}`,
      [userId, displayName],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`,
      [userId, passwordHash],
    );
  }

  async linkGithub(
    userId: string,
    githubId: string,
    githubLogin: string,
  ): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      `UPDATE users
       SET github_id = $2, github_login = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING ${userColumns}`,
      [userId, githubId, githubLogin],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async unlinkGithub(userId: string): Promise<User | null> {
    const result = await this.db.query<UserRow>(
      `UPDATE users
       SET github_id = NULL, github_login = NULL, updated_at = NOW()
       WHERE id = $1
       RETURNING ${userColumns}`,
      [userId],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }
}
