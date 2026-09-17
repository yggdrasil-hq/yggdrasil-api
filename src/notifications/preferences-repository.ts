import type pg from "pg";
import type { NotificationPreference } from "./preferences.js";

interface PreferenceRow {
  id: string;
  user_id: string;
  organization_id: string;
  kind: string | null;
  enabled: boolean;
}

const preferenceColumns = `
  id, user_id, organization_id, kind, enabled
`;

function mapPreference(row: PreferenceRow): NotificationPreference {
  return {
    id: row.id,
    userId: row.user_id,
    organizationId: row.organization_id,
    kind: row.kind,
    enabled: row.enabled,
  };
}

/**
 * Reads and writes the two tables behind ADR 027. The decision itself lives in
 * `preferences.ts` (`shouldNotify`); this class only loads the rows that
 * decision needs and stores the rows the settings UI sets.
 */
export class NotificationPreferencesRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Every preference row this user has for one organization — both concrete
   * kinds and the NULL-kind master row. Typically a handful of rows.
   */
  async listForUserOrganization(
    userId: string,
    organizationId: string,
  ): Promise<NotificationPreference[]> {
    const result = await this.db.query<PreferenceRow>(
      `SELECT ${preferenceColumns}
       FROM notification_preferences
       WHERE user_id = $1 AND organization_id = $2`,
      [userId, organizationId],
    );
    return result.rows.map(mapPreference);
  }

  /**
   * Upserts one row, where `kind: null` targets the org-wide master row.
   *
   * The two branches are not a stylistic choice: Postgres resolves ON CONFLICT
   * against one specific index, and the NULL-kind row is covered by the partial
   * index that the concrete-kind branch does not match (migration 031).
   */
  async setPreference(input: {
    userId: string;
    organizationId: string;
    kind: string | null;
    enabled: boolean;
  }): Promise<NotificationPreference> {
    const { userId, organizationId, kind, enabled } = input;

    const result =
      kind === null
        ? await this.db.query<PreferenceRow>(
            `INSERT INTO notification_preferences (user_id, organization_id, kind, enabled)
             VALUES ($1, $2, NULL, $3)
             ON CONFLICT (user_id, organization_id) WHERE kind IS NULL
             DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
             RETURNING ${preferenceColumns}`,
            [userId, organizationId, enabled],
          )
        : await this.db.query<PreferenceRow>(
            `INSERT INTO notification_preferences (user_id, organization_id, kind, enabled)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_id, organization_id, kind) WHERE kind IS NOT NULL
             DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
             RETURNING ${preferenceColumns}`,
            [userId, organizationId, kind, enabled],
          );

    return mapPreference(result.rows[0]);
  }

  /** The ids of every project this user has muted, across all organizations. */
  async listMutedProjectIds(userId: string): Promise<string[]> {
    const result = await this.db.query<{ project_id: string }>(
      `SELECT project_id FROM project_notification_mutes WHERE user_id = $1`,
      [userId],
    );
    return result.rows.map((row) => row.project_id);
  }

  async isProjectMuted(userId: string, projectId: string): Promise<boolean> {
    const result = await this.db.query<{ muted: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM project_notification_mutes
         WHERE user_id = $1 AND project_id = $2
       ) AS muted`,
      [userId, projectId],
    );
    return result.rows[0]?.muted ?? false;
  }

  /** Mutes or unmutes one project for one user. Idempotent either way. */
  async setProjectMute(
    userId: string,
    projectId: string,
    muted: boolean,
  ): Promise<void> {
    if (muted) {
      await this.db.query(
        `INSERT INTO project_notification_mutes (user_id, project_id)
         VALUES ($1, $2)
         ON CONFLICT (user_id, project_id) DO NOTHING`,
        [userId, projectId],
      );
      return;
    }
    await this.db.query(
      `DELETE FROM project_notification_mutes WHERE user_id = $1 AND project_id = $2`,
      [userId, projectId],
    );
  }

  /**
   * The organization a project belongs to — the scope preferences are keyed by.
   *
   * `notifications` stores only `project_id`, so a notification's organization
   * is reached through its project. Returns null when the project is unknown,
   * which the caller treats as "no preferences can apply".
   */
  async organizationIdForProject(projectId: string): Promise<string | null> {
    const result = await this.db.query<{ organization_id: string }>(
      `SELECT organization_id FROM projects WHERE id = $1`,
      [projectId],
    );
    return result.rows[0]?.organization_id ?? null;
  }
}
