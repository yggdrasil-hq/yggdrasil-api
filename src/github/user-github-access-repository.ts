import type pg from "pg";

/**
 * Tracks which installations a given user can actually see on GitHub
 * (`user_installation_access`) and when we last confirmed that live
 * (`user_github_sync_state`) — separate from `github_installations`, which
 * stays a global, app-level fact table.
 */
export class UserGithubAccessRepository {
  constructor(private readonly db: pg.Pool) {}

  async upsertAccess(userId: string, installationId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO user_installation_access (user_id, installation_id, last_confirmed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, installation_id) DO UPDATE SET last_confirmed_at = NOW()`,
      [userId, installationId],
    );
  }

  async getLastSyncedAt(userId: string): Promise<Date | null> {
    const result = await this.db.query<{ last_synced_at: Date }>(
      `SELECT last_synced_at FROM user_github_sync_state WHERE user_id = $1`,
      [userId],
    );
    return result.rows[0]?.last_synced_at ?? null;
  }

  async touchSyncState(userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO user_github_sync_state (user_id, last_synced_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_synced_at = NOW()`,
      [userId],
    );
  }
}
