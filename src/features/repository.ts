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
   * Moves a feature to in_review on a successful feature_build run (ADR 010
   * item 9) and persists the opened draft PR's URL. Deliberately no
   * `WHERE status = ...` guard, unlike approveAdr: nothing in this codebase
   * yet flips a feature to 'running' when its feature_build job actually
   * starts (a separate, undecided gap — the job goes straight from
   * 'queued' to whatever this call sets), and run_failed/run_cancelled's
   * own updateStatus calls below are equally unguarded — this matches that
   * existing precedent rather than silently no-op'ing on a status this
   * feature was never actually moved into.
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
