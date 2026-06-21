import type pg from "pg";

export class GithubTokenRepository {
  constructor(private readonly db: pg.Pool) {}

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
