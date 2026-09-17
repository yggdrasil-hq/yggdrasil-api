import type pg from "pg";
import type { Notification } from "./types.js";
import { shouldNotify } from "./preferences.js";
import { NotificationPreferencesRepository } from "./preferences-repository.js";

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
  private readonly preferences: NotificationPreferencesRepository;

  constructor(private readonly db: pg.Pool) {
    this.preferences = new NotificationPreferencesRepository(db);
  }

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

  /**
   * Records a notification, unless the user's preferences (ADR 027) suppress
   * it — in which case nothing is inserted and this returns null.
   *
   * Preferences are applied here, at creation, rather than filtered when the
   * list is read: a suppressed notification is one the user never wanted, and
   * keeping it out of the table is what makes the inbox and the unread count
   * agree without every reader re-applying the rules. The consequence (enabling
   * a kind later does not backfill what was suppressed) is documented in the
   * ADR.
   *
   * Callers ignore the return value; null is the suppression signal.
   */
  async create(input: {
    userId: string;
    projectId?: string;
    kind: string;
    title: string;
    body?: string;
    linkPath?: string;
  }): Promise<Notification | null> {
    const projectId = input.projectId ?? null;
    if (!(await this.shouldRecord(input.userId, input.kind, projectId))) {
      return null;
    }

    const result = await this.db.query<NotificationRow>(
      `INSERT INTO notifications (user_id, project_id, kind, title, body, link_path)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${notificationColumns}`,
      [
        input.userId,
        projectId,
        input.kind,
        input.title,
        input.body ?? null,
        input.linkPath ?? null,
      ],
    );
    return mapNotification(result.rows[0]);
  }

  /**
   * Whether this user wants this notification at all.
   *
   * A notification with no project cannot be traced to an organization —
   * `notifications` stores only `project_id`, and both preference shapes are
   * keyed off the project — so no preference row can match and the answer is
   * "notify". That is the safe direction (it preserves pre-preferences
   * behaviour) and it is stated in the ADR rather than left implicit. Every
   * create site passes a project today; the branch exists because the column
   * is nullable.
   */
  private async shouldRecord(
    userId: string,
    kind: string,
    projectId: string | null,
  ): Promise<boolean> {
    if (projectId === null) return true;

    const organizationId = await this.preferences.organizationIdForProject(projectId);
    if (!organizationId) return true;

    const [preferences, projectMuted] = await Promise.all([
      this.preferences.listForUserOrganization(userId, organizationId),
      this.preferences.isProjectMuted(userId, projectId),
    ]);

    return shouldNotify({ kind, projectId, projectMuted, preferences });
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
