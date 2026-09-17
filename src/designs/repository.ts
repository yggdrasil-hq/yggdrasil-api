import type pg from "pg";
import type {
  Design,
  DesignSessionSummary,
  DesignStatus,
  DesignWithLatestSession,
} from "./types.js";

interface DesignRow {
  id: string;
  project_id: string;
  name: string;
  slug: string;
  status: DesignStatus;
  origin_job_id: string | null;
  pr_url: string | null;
  finalized_at: Date | null;
  created_at: Date;
  updated_at: Date;
  latest_session_id?: string | null;
  latest_session_status?: DesignSessionSummary["status"] | null;
  latest_session_created_at?: Date | null;
  latest_session_completed_at?: Date | null;
  latest_session_last_error?: string | null;
}

const designColumns = `
  d.id, d.project_id, d.name, d.slug, d.status, d.origin_job_id, d.pr_url,
  d.finalized_at, d.created_at, d.updated_at
`;

/**
 * The latest session for a design, as a LATERAL join so the browse list stays
 * one query per page instead of N+1. History and status belong to the session
 * job (ADR 020 item 3), so this is a read-through, never a copy.
 */
const latestSessionJoin = `
  LEFT JOIN LATERAL (
    SELECT j.id, j.status, j.created_at, j.completed_at, j.last_error
    FROM jobs j
    WHERE j.design_id = d.id
    ORDER BY j.created_at DESC
    LIMIT 1
  ) latest ON TRUE
`;

const latestSessionColumns = `
  latest.id AS latest_session_id,
  latest.status AS latest_session_status,
  latest.created_at AS latest_session_created_at,
  latest.completed_at AS latest_session_completed_at,
  latest.last_error AS latest_session_last_error
`;

function mapDesign(row: DesignRow): Design {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    originJobId: row.origin_job_id,
    prUrl: row.pr_url,
    finalizedAt: row.finalized_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLatestSession(row: DesignRow): DesignSessionSummary | null {
  if (!row.latest_session_id || !row.latest_session_status || !row.latest_session_created_at) {
    return null;
  }
  return {
    id: row.latest_session_id,
    status: row.latest_session_status,
    createdAt: row.latest_session_created_at,
    completedAt: row.latest_session_completed_at ?? null,
    lastError: row.latest_session_last_error ?? null,
  };
}

/** What a re-opened session needs to know about the design it continues. */
export interface DesignContinuationContext {
  sessionId: string;
  prUrl: string | null;
  paths: string[];
}

/** A project's design index. See ADR 020 — the artifact itself lives in git. */
export class DesignRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Records that a `design_grill` session is working on `slug`, and links the
   * session to it.
   *
   * Upsert on (project_id, slug) is the whole re-open mechanism: the slug IS
   * the artifact's identity (`designs/<slug>/`), so "start a new design" and
   * "continue this design" are the same call and cannot produce a duplicate
   * row. On conflict only `updated_at` moves — the design's name, slug and
   * origin are fixed at creation, so a later session iterating the same folder
   * cannot silently rename the index entry out of step with the folder name.
   * A user who wants a differently-named design gets it by choosing a
   * different slug, which is the only thing that changes the artifact.
   */
  async startSession(input: {
    projectId: string;
    name: string;
    slug: string;
    jobId: string;
  }): Promise<Design> {
    const result = await this.db.query<DesignRow>(
      `INSERT INTO designs (project_id, name, slug, origin_job_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, slug) DO UPDATE
         SET updated_at = NOW()
       RETURNING id, project_id, name, slug, status, origin_job_id, pr_url,
                 finalized_at, created_at, updated_at`,
      [input.projectId, input.name, input.slug, input.jobId],
    );
    const design = mapDesign(result.rows[0]);

    await this.linkSession(design.id, input.jobId);
    return design;
  }

  /** Points a session job at its design, so history is one indexed lookup. */
  async linkSession(designId: string, jobId: string): Promise<void> {
    await this.db.query(`UPDATE jobs SET design_id = $1 WHERE id = $2`, [designId, jobId]);
  }

  /**
   * Marks the design finalized once its session calls `submit_design`.
   *
   * Keyed by (project_id, slug) and written as an upsert so it is
   * self-healing: a session whose index row was never written (a start-time
   * failure, or a session that predates the index) still lands a correct row
   * at exactly the moment it becomes committed and worth browsing. Idempotent,
   * so a replayed event cannot double-apply.
   */
  async finalize(input: {
    projectId: string;
    name: string;
    slug: string;
    jobId: string;
    prUrl: string | null;
  }): Promise<Design> {
    const result = await this.db.query<DesignRow>(
      `INSERT INTO designs (project_id, name, slug, status, origin_job_id, pr_url, finalized_at)
       VALUES ($1, $2, $3, 'finalized', $4, $5, NOW())
       ON CONFLICT (project_id, slug) DO UPDATE
         SET status = 'finalized',
             pr_url = COALESCE(EXCLUDED.pr_url, designs.pr_url),
             finalized_at = COALESCE(designs.finalized_at, NOW()),
             updated_at = NOW()
       RETURNING id, project_id, name, slug, status, origin_job_id, pr_url,
                 finalized_at, created_at, updated_at`,
      [input.projectId, input.name, input.slug, input.jobId, input.prUrl],
    );
    const design = mapDesign(result.rows[0]);
    await this.linkSession(design.id, input.jobId);
    return design;
  }

  /**
   * A project's designs, most recently touched first, each with the status of
   * its latest session. Bounded rather than paginated: a project's design
   * folder count is a human-scale number (ADR 020 item 6).
   */
  async listForProject(
    projectId: string,
    limit = 200,
  ): Promise<DesignWithLatestSession[]> {
    const result = await this.db.query<DesignRow>(
      `SELECT ${designColumns}, ${latestSessionColumns}
       FROM designs d
       ${latestSessionJoin}
       WHERE d.project_id = $1
       ORDER BY d.updated_at DESC
       LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map((row) => ({
      design: mapDesign(row),
      latestSession: mapLatestSession(row),
    }));
  }

  /** One design, scoped to its project — the authorization boundary. */
  async findByIdForProject(
    projectId: string,
    designId: string,
  ): Promise<DesignWithLatestSession | null> {
    const result = await this.db.query<DesignRow>(
      `SELECT ${designColumns}, ${latestSessionColumns}
       FROM designs d
       ${latestSessionJoin}
       WHERE d.project_id = $1 AND d.id = $2`,
      [projectId, designId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { design: mapDesign(row), latestSession: mapLatestSession(row) };
  }

  /** Every session that has worked on a design, newest first. */
  async listSessions(designId: string): Promise<DesignSessionSummary[]> {
    const result = await this.db.query<{
      id: string;
      status: DesignSessionSummary["status"];
      created_at: Date;
      completed_at: Date | null;
      last_error: string | null;
    }>(
      `SELECT id, status, created_at, completed_at, last_error
       FROM jobs
       WHERE design_id = $1
       ORDER BY created_at DESC`,
      [designId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      lastError: row.last_error,
    }));
  }

  /**
   * What a re-opened session should be told about the design it continues:
   * the last finalized session's draft PR, and the file paths that session
   * committed.
   *
   * Only the path *keys* are read out of the stored snapshot (via
   * `jsonb_object_keys`), never the HTML — the agent can read the files from
   * the checkout, and pulling whole mockups through this query would be
   * wasteful for data it already has on disk.
   *
   * `excludeJobId` keeps a session from being seeded with itself.
   */
  async findContinuationContext(
    projectId: string,
    slug: string,
    excludeJobId: string,
  ): Promise<DesignContinuationContext | null> {
    const result = await this.db.query<{
      session_id: string;
      pr_url: string | null;
      paths: string[] | null;
    }>(
      `SELECT j.id AS session_id,
              e.pr_url,
              (SELECT jsonb_agg(k ORDER BY k)
                 FROM jsonb_object_keys(e.design_snapshot) AS k) AS paths
       FROM job_events e
       JOIN jobs j ON j.id = e.job_id
       WHERE j.project_id = $1
         AND j.kind = 'design_grill'
         AND j.design_slug = $2
         AND j.id <> $3
         AND e.type = 'submit_design'
       ORDER BY e.created_at DESC
       LIMIT 1`,
      [projectId, slug, excludeJobId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { sessionId: row.session_id, prUrl: row.pr_url, paths: row.paths ?? [] };
  }
}
