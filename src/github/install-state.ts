import { randomBytes } from "node:crypto";
import type pg from "pg";

export interface InstallStateRecord {
  state: string;
  userId: string;
  draftName: string;
  draftDescription: string;
  returnTo: string | null;
}

export class InstallStateRepository {
  constructor(private readonly db: pg.Pool) {}

  async create(input: {
    userId: string;
    draftName: string;
    draftDescription?: string;
    returnTo?: string | null;
  }): Promise<InstallStateRecord> {
    const state = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await this.db.query(
      `INSERT INTO install_states (state, user_id, draft_name, draft_description, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        state,
        input.userId,
        input.draftName,
        input.draftDescription ?? "",
        input.returnTo ?? null,
        expiresAt,
      ],
    );
    return {
      state,
      userId: input.userId,
      draftName: input.draftName,
      draftDescription: input.draftDescription ?? "",
      returnTo: input.returnTo ?? null,
    };
  }

  async consume(state: string): Promise<InstallStateRecord | null> {
    const result = await this.db.query<{
      state: string;
      user_id: string;
      draft_name: string;
      draft_description: string;
      return_to: string | null;
    }>(
      `DELETE FROM install_states
       WHERE state = $1 AND expires_at > NOW()
       RETURNING state, user_id, draft_name, draft_description, return_to`,
      [state],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      state: row.state,
      userId: row.user_id,
      draftName: row.draft_name,
      draftDescription: row.draft_description,
      returnTo: row.return_to,
    };
  }
}
