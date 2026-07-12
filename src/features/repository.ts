import type pg from "pg";
import { uniqueSlug } from "../shared/slug.js";
import type { Feature, FeatureStatus, FeatureType } from "./types.js";

interface FeatureRow {
  id: string;
  project_id: string;
  title: string;
  slug: string;
  feature_type: FeatureType;
  status: FeatureStatus;
  adr_markdown: string | null;
  awaiting_user_input: boolean;
  adr_approved: boolean;
  branch_name: string | null;
  pr_url: string | null;
  created_at: Date;
  updated_at: Date;
}

const featureColumns = `
  id, project_id, title, slug, feature_type, status, adr_markdown,
  awaiting_user_input, adr_approved, branch_name, pr_url, created_at, updated_at
`;

function mapFeature(row: FeatureRow): Feature {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    slug: row.slug,
    featureType: row.feature_type,
    status: row.status,
    adrMarkdown: row.adr_markdown,
    awaitingUserInput: row.awaiting_user_input,
    adrApproved: row.adr_approved,
    branchName: row.branch_name,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FeatureRepository {
  constructor(private readonly db: pg.Pool) {}

  async listByProject(projectId: string): Promise<Feature[]> {
    const result = await this.db.query<FeatureRow>(
      `SELECT ${featureColumns}
       FROM features
       WHERE project_id = $1
       ORDER BY updated_at DESC`,
      [projectId],
    );
    return result.rows.map(mapFeature);
  }

  async findById(projectId: string, featureId: string): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `SELECT ${featureColumns}
       FROM features
       WHERE project_id = $1 AND id = $2`,
      [projectId, featureId],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  async findProjectInit(projectId: string): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `SELECT ${featureColumns}
       FROM features
       WHERE project_id = $1 AND feature_type = 'project_init'
       LIMIT 1`,
      [projectId],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  async create(input: {
    projectId: string;
    title: string;
    featureType?: FeatureType;
  }): Promise<Feature> {
    const slug = await uniqueSlug(input.title, async (candidate) => {
      const existing = await this.db.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM features WHERE project_id = $1 AND slug = $2
         ) AS exists`,
        [input.projectId, candidate],
      );
      return existing.rows[0]?.exists ?? false;
    });

    const result = await this.db.query<FeatureRow>(
      `INSERT INTO features (project_id, title, slug, feature_type, status)
       VALUES ($1, $2, $3, $4, 'draft')
       RETURNING ${featureColumns}`,
      [input.projectId, input.title, slug, input.featureType ?? "normal"],
    );
    return mapFeature(result.rows[0]);
  }

  async updateAdr(featureId: string, adrMarkdown: string): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `UPDATE features
       SET adr_markdown = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING ${featureColumns}`,
      [featureId, adrMarkdown],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  async setSpecReady(featureId: string, adrMarkdown: string): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `UPDATE features
       SET adr_markdown = $2,
           status = 'spec_ready',
           awaiting_user_input = FALSE,
           updated_at = NOW()
       WHERE id = $1
       RETURNING ${featureColumns}`,
      [featureId, adrMarkdown],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  async approveAdr(featureId: string): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `UPDATE features
       SET adr_approved = TRUE, updated_at = NOW()
       WHERE id = $1 AND status = 'spec_ready'
       RETURNING ${featureColumns}`,
      [featureId],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  async queueBuild(featureId: string): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `UPDATE features
       SET status = 'queued', updated_at = NOW()
       WHERE id = $1 AND status = 'spec_ready' AND adr_approved = TRUE
       RETURNING ${featureColumns}`,
      [featureId],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  /**
   * Moves a feature queued -> running on the Orchestrator's synthesized
   * run_started event (ADR 011), once a feature_build (or spec_grill) job's
   * pod is confirmed up. Guarded by `WHERE status = 'queued'`, unlike
   * setInReview/updateStatus below: this is what lets run_started fire
   * uniformly for both job kinds with no job-kind check anywhere in
   * syncFeatureState — a spec_grill feature sits in 'draft' when this
   * event arrives, so the guard makes the call a no-op there.
   */
  async setRunning(featureId: string): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `UPDATE features
       SET status = 'running', updated_at = NOW()
       WHERE id = $1 AND status = 'queued'
       RETURNING ${featureColumns}`,
      [featureId],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  /**
   * Moves a feature to in_review on a successful feature_build run (ADR 010
   * item 9) and persists the opened draft PR's URL. Deliberately no
   * `WHERE status = ...` guard, unlike approveAdr/setRunning: matches the
   * existing (pre-ADR-011) precedent of run_failed/run_cancelled's own
   * updateStatus calls below rather than silently no-op'ing here too.
   */
  async setInReview(featureId: string, prUrl: string): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `UPDATE features
       SET status = 'in_review', pr_url = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING ${featureColumns}`,
      [featureId, prUrl],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  /**
   * Re-enters a failed feature back into the `draft` state so a retried
   * spec_grill job drives the same state machine a first attempt does
   * (ADR 012). Guarded `WHERE status = 'failed'`, mirroring setRunning's
   * ADR-011 precedent: safe to call from any context, and no-ops under a
   * race instead of clobbering a state set by something else in between.
   */
  async resetForRetry(featureId: string): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `UPDATE features
       SET status = 'draft', awaiting_user_input = FALSE, updated_at = NOW()
       WHERE id = $1 AND status = 'failed'
       RETURNING ${featureColumns}`,
      [featureId],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  async setAwaitingUserInput(
    featureId: string,
    awaiting: boolean,
  ): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `UPDATE features
       SET awaiting_user_input = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING ${featureColumns}`,
      [featureId, awaiting],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }

  async hasBlockingStatuses(projectId: string): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM features
         WHERE project_id = $1
           AND status IN ('draft', 'queued', 'running')
       ) AS exists`,
      [projectId],
    );
    return result.rows[0]?.exists ?? false;
  }

  async updateStatus(
    featureId: string,
    status: FeatureStatus,
  ): Promise<Feature | null> {
    const result = await this.db.query<FeatureRow>(
      `UPDATE features
       SET status = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING ${featureColumns}`,
      [featureId, status],
    );
    return result.rows[0] ? mapFeature(result.rows[0]) : null;
  }
}
