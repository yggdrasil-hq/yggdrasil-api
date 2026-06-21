import type pg from "pg";
import { config } from "../config.js";

export class LoginRateLimiter {
  constructor(private readonly db: pg.Pool) {}

  async recordFailure(username: string, ip: string): Promise<void> {
    await this.db.query(
      `INSERT INTO login_attempts (username, ip_address) VALUES ($1, $2::inet)`,
      [username, ip],
    );
  }

  async isBlocked(username: string, ip: string): Promise<boolean> {
    const windowStart = new Date(Date.now() - config.rateLimit.perUsername.windowMs);
    const [byUser, byIp] = await Promise.all([
      this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM login_attempts
         WHERE username = $1 AND attempted_at >= $2`,
        [username, windowStart],
      ),
      this.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM login_attempts
         WHERE ip_address = $2::inet AND attempted_at >= $1`,
        [windowStart, ip],
      ),
    ]);

    const userCount = Number(byUser.rows[0]?.count ?? 0);
    const ipCount = Number(byIp.rows[0]?.count ?? 0);
    return (
      userCount >= config.rateLimit.perUsername.max ||
      ipCount >= config.rateLimit.perIp.max
    );
  }
}

export function getClientIp(req: { ip?: string; headers: Record<string, unknown> }): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? "0.0.0.0";
  }
  return req.ip ?? "0.0.0.0";
}
