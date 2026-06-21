import { randomUUID } from "node:crypto";
import type pg from "pg";
import { config } from "../config.js";
import type { User } from "../users/types.js";

export interface SessionRecord {
  id: string;
  userId: string;
  rememberMe: boolean;
  expiresAt: Date;
}

export class SessionService {
  constructor(private readonly db: pg.Pool) {}

  ttlMs(rememberMe: boolean): number {
    return rememberMe ? config.sessionTtl.rememberMs : config.sessionTtl.defaultMs;
  }

  async create(user: User, rememberMe: boolean): Promise<SessionRecord> {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + this.ttlMs(rememberMe));
    await this.db.query(
      `INSERT INTO sessions (id, user_id, remember_me, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [id, user.id, rememberMe, expiresAt],
    );
    return { id, userId: user.id, rememberMe, expiresAt };
  }

  async findValid(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.db.query<{
      id: string;
      user_id: string;
      remember_me: boolean;
      expires_at: Date;
    }>(
      `SELECT id, user_id, remember_me, expires_at
       FROM sessions
       WHERE id = $1 AND expires_at > NOW()`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      rememberMe: row.remember_me,
      expiresAt: row.expires_at,
    };
  }

  async touch(session: SessionRecord): Promise<SessionRecord> {
    const expiresAt = new Date(Date.now() + this.ttlMs(session.rememberMe));
    await this.db.query(
      `UPDATE sessions SET last_seen_at = NOW(), expires_at = $2 WHERE id = $1`,
      [session.id, expiresAt],
    );
    return { ...session, expiresAt };
  }

  async delete(sessionId: string): Promise<void> {
    await this.db.query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);
  }

  async deleteAllForUserExcept(userId: string, exceptSessionId?: string): Promise<void> {
    if (exceptSessionId) {
      await this.db.query(
        `DELETE FROM sessions WHERE user_id = $1 AND id <> $2`,
        [userId, exceptSessionId],
      );
      return;
    }
    await this.db.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
  }
}
