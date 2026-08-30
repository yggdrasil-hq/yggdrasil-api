import type pg from "pg";
import type { FeatureActionItemType } from "./types.js";
import type { FeatureActionItem } from "./action-items-types.js";

interface ActionItemRow {
  id: string;
  feature_id: string;
  type: FeatureActionItemType;
  description: string;
  status: "open" | "resolved";
  resolved_at: Date | null;
  secret_key: string | null;
  design_session_id: string | null;
  subtask_feature_id: string | null;
  draft_test_markdown: string | null;
  design_snapshot: Record<string, string> | null;
  created_at: Date;
  updated_at: Date;
}

const columns = `
  id, feature_id, type, description, status, resolved_at,
  secret_key, design_session_id, subtask_feature_id, draft_test_markdown,
  design_snapshot,
  created_at, updated_at
`;

function map(row: ActionItemRow): FeatureActionItem {
  return {
    id: row.id,
    featureId: row.feature_id,
    type: row.type,
    description: row.description,
    status: row.status,
    resolvedAt: row.resolved_at,
    secretKey: row.secret_key,
    designSessionId: row.design_session_id,
    subtaskFeatureId: row.subtask_feature_id,
    draftTestMarkdown: row.draft_test_markdown,
    designSnapshot: row.design_snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * ADR 015 items 4-6: Action Items are generated once per spec_grill run at
 * the draft -> spec_ready transition, and each resolves by its own mechanic.
 */
export class FeatureActionItemRepository {
  constructor(private readonly db: pg.Pool) {}

  async listForFeature(featureId: string): Promise<FeatureActionItem[]> {
    const result = await this.db.query<ActionItemRow>(
      `SELECT ${columns} FROM feature_action_items
       WHERE feature_id = $1 ORDER BY created_at ASC`,
      [featureId],
    );
    return result.rows.map(map);
  }

  async createMany(featureId: string, items: Array<{
    type: FeatureActionItemType;
    description: string;
    secretKey?: string | null;
    designSessionId?: string | null;
    subtaskFeatureId?: string | null;
    draftTestMarkdown?: string | null;
    designSnapshot?: Record<string, string> | null;
  }>): Promise<FeatureActionItem[]> {
    const created: FeatureActionItem[] = [];
    for (const item of items) {
      const result = await this.db.query<ActionItemRow>(
        `INSERT INTO feature_action_items
           (feature_id, type, description, secret_key, design_session_id,
            subtask_feature_id, draft_test_markdown, design_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${columns}`,
        [
          featureId,
          item.type,
          item.description,
          item.secretKey ?? null,
          item.designSessionId ?? null,
          item.subtaskFeatureId ?? null,
          item.draftTestMarkdown ?? null,
          item.designSnapshot ?? null,
        ],
      );
      created.push(map(result.rows[0]));
    }
    return created;
  }

  async findById(featureId: string, itemId: string): Promise<FeatureActionItem | null> {
    const result = await this.db.query<ActionItemRow>(
      `SELECT ${columns} FROM feature_action_items
       WHERE feature_id = $1 AND id = $2`,
      [featureId, itemId],
    );
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async resolve(itemId: string): Promise<void> {
    await this.db.query(
      `UPDATE feature_action_items
       SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'open'`,
      [itemId],
    );
  }

  /** Env-var/secret requests auto-resolve by polling whether the key exists (ADR 015 item 5). */
  async resolveSecretItemIfPresent(itemId: string, projectSecrets: Record<string, string>): Promise<boolean> {
    const result = await this.db.query<{ secret_key: string | null }>(
      `SELECT secret_key FROM feature_action_items WHERE id = $1 AND type = 'secret_request'`,
      [itemId],
    );
    const key = result.rows[0]?.secret_key;
    if (key && Object.prototype.hasOwnProperty.call(projectSecrets, key)) {
      await this.resolve(itemId);
      return true;
    }
    return false;
  }

  /**
   * Drops all open Action Items for a feature. Used on kickback (ADR 015 item
   * 8): a feature landing back in `draft` for a fresh spec_grill must have a
   * clean slate, so the *new* run's submit_adr batch replaces the old one
   * rather than merging with it.
   */
  async clearForFeature(featureId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM feature_action_items WHERE feature_id = $1 AND status = 'open'`,
      [featureId],
    );
  }

  async countOpenForFeature(featureId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM feature_action_items
       WHERE feature_id = $1 AND status = 'open'`,
      [featureId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /** Resolves a `subtask_feature` action item the moment the subtask reaches merged (ADR 015 item 5). */
  async resolveSubtaskItem(subtaskFeatureId: string): Promise<void> {
    await this.db.query(
      `UPDATE feature_action_items
       SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
       WHERE type = 'subtask_feature'
         AND subtask_feature_id = $1
         AND status = 'open'`,
      [subtaskFeatureId],
    );
  }

  async linkDesignSession(
    featureId: string,
    itemId: string,
    designSessionId: string,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE feature_action_items
       SET design_session_id = $3, updated_at = NOW()
       WHERE feature_id = $1 AND id = $2 AND type = 'design_grill'
       RETURNING id`,
      [featureId, itemId, designSessionId],
    );
    return result.rowCount !== 0;
  }

  /**
   * A design item is resolved by the terminal submit_design event, not by a
   * generic human resolve click. Keeping the finalized snapshot on the item
   * makes it available to a later spec_grill even though Design is not yet a
   * first-class persisted entity (ADR 014 item 13).
   */
  async resolveDesignSession(
    designSessionId: string,
    snapshot: Record<string, string>,
  ): Promise<void> {
    await this.db.query(
      `UPDATE feature_action_items
       SET status = 'resolved',
           resolved_at = NOW(),
           design_snapshot = $2,
           updated_at = NOW()
       WHERE design_session_id = $1 AND type = 'design_grill' AND status = 'open'`,
      [designSessionId, snapshot],
    );
  }

  async listResolvedDesignSnapshots(
    featureId: string,
  ): Promise<Array<{ sessionId: string; snapshot: Record<string, string> }>> {
    const result = await this.db.query<{
      design_session_id: string;
      design_snapshot: Record<string, string> | null;
    }>(
      `SELECT design_session_id, design_snapshot
       FROM feature_action_items
       WHERE feature_id = $1
         AND type = 'design_grill'
         AND status = 'resolved'
         AND design_session_id IS NOT NULL
         AND design_snapshot IS NOT NULL
       ORDER BY resolved_at ASC`,
      [featureId],
    );
    return result.rows.map((row) => ({
      sessionId: row.design_session_id,
      snapshot: row.design_snapshot ?? {},
    }));
  }
}