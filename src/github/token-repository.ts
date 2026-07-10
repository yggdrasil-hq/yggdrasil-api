import type pg from "pg";

export interface GithubUserToken {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
}

interface TokenRow {
  access_token: string;
  refresh_token: string | null;
  scopes: string[];
}

export class GithubTokenRepository {
  constructor(private readonly db: pg.Pool) {}

  async get(userId: string): Promise<GithubUserToken | null> {
    const result = await this.db.query<TokenRow>(
      `SELECT access_token, refresh_token, scopes FROM github_tokens WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { accessToken: row.access_token, refreshToken: row.refresh_token, scopes: row.scopes };
  }

  async updateAccessToken(
    userId: string,
    accessToken: string,
    refreshToken?: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE github_tokens SET
         access_token = $2,
         refresh_token = COALESCE($3, refresh_token),
         updated_at = NOW()
       WHERE user_id = $1`,
      [userId, accessToken, refreshToken ?? null],
    );
  }

  async upsert(
    userId: string,
    accessToken: string,
    scopes: string[],
    refreshToken?: string | null,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO github_tokens (user_id, access_token, refresh_token, scopes, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         access_token = EXCLUDED.access_token,
         refresh_token = EXCLUDED.refresh_token,
         scopes = EXCLUDED.scopes,
         updated_at = NOW()`,
      [userId, accessToken, refreshToken ?? null, scopes],
    );
  }

  async delete(userId: string): Promise<void> {
    await this.db.query(`DELETE FROM github_tokens WHERE user_id = $1`, [userId]);
  }

  async getScopes(userId: string): Promise<string[]> {
    const result = await this.db.query<{ scopes: string[] }>(
      `SELECT scopes FROM github_tokens WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0]?.scopes ?? [];
  }
}
