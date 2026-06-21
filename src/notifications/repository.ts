import type pg from "pg";
import type { Notification } from "./types.js";

interface NotificationRow {
  id: string;
  user_id: string;
  project_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  link_path: string | null;
  read_at: Date | null;
  created_at: Date;
}

const notificationColumns = `
  id, user_id, project_id, kind, title, body, link_path, read_at, created_at
`;

function mapNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    linkPath: row.link_path,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export class NotificationRepository {
  constructor(private readonly db: pg.Pool) {}

  async listForUser(userId: string, limit = 50): Promise<Notification[]> {
    const result = await this.db.query<NotificationRow>(
      `SELECT ${notificationColumns}
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return result.rows.map(mapNotification);
  }

  async unreadCount(userId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM notifications
       WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async create(input: {
    userId: string;
    projectId?: string;
    kind: string;
    title: string;
    body?: string;
    linkPath?: string;
  }): Promise<Notification> {
    const result = await this.db.query<NotificationRow>(
      `INSERT INTO notifications (user_id, project_id, kind, title, body, link_path)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${notificationColumns}`,
      [
        input.userId,
        input.projectId ?? null,
        input.kind,
        input.title,
        input.body ?? null,
        input.linkPath ?? null,
      ],
    );
    return mapNotification(result.rows[0]);
  }

  async markRead(notificationId: string, userId: string): Promise<Notification | null> {
    const result = await this.db.query<NotificationRow>(
      `UPDATE notifications
       SET read_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING ${notificationColumns}`,
      [notificationId, userId],
    );
    return result.rows[0] ? mapNotification(result.rows[0]) : null;
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
  }
}
