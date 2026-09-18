import type pg from "pg";
import type {
  ProjectDeploy,
  ProjectDeployKind,
  ProjectDeployStatus,
  RollbackTarget,
} from "./types.js";

interface ProjectDeployRow {
  id: string;
  project_id: string;
  job_id: string | null;
  kind: ProjectDeployKind;
  helm_revision: number | null;
  target_revision: number | null;
  status: ProjectDeployStatus;
  last_error: string | null;
  ref: string | null;
  created_at: Date;
}

const deployColumns = `
    id, project_id, job_id, kind, helm_revision, target_revision,
    status, last_error, ref, created_at
`;

function mapDeploy(row: ProjectDeployRow): ProjectDeploy {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    kind: row.kind,
    helmRevision: row.helm_revision,
    targetRevision: row.target_revision,
    status: row.status,
    lastError: row.last_error,
    ref: row.ref,
    createdAt: row.created_at,
  };
}

/**
 * ADR 022: append-only storage for a project's deploy history.
 *
 * There is deliberately no update or delete path. The ledger exists so a
 * deployment can be identified and reverted after the fact, which only works
 * if a recorded revision can never be rewritten; correcting a bad row is a
 * new row, not an edit. Deploy history is therefore a superset of what is
 * currently running, not a mirror of it — the newest row that produced a
 * revision is what is live.
 */
export class ProjectDeployRepository {
  constructor(private readonly db: pg.Pool) {}

  /**
   * Writes one terminal outcome to the ledger, idempotently.
   *
   * `job_id` is unique (migration 043), so a report that is delivered twice —
   * the Orchestrator retries a lost one (#26), and "the write landed but the
   * response didn't" is precisely what a retry cannot distinguish — records one
   * row rather than two. A deploy job reaches exactly one terminal state and
   * reports it once, so the second delivery is always the same fact restated.
   *
   * Returns the stored row either way, so the caller cannot tell a fresh write
   * from a duplicate delivery: both mean "this outcome is in the ledger".
   */
  async record(input: {
    projectId: string;
    jobId: string;
    kind: ProjectDeployKind;
    /** Null when the attempt produced no new revision (a failure). */
    helmRevision: number | null;
    targetRevision?: number | null;
    status: ProjectDeployStatus;
    lastError?: string | null;
    ref?: string | null;
  }): Promise<ProjectDeploy> {
    const result = await this.db.query<ProjectDeployRow>(
      `INSERT INTO project_deploys
         (project_id, job_id, kind, helm_revision, target_revision,
          status, last_error, ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (job_id) WHERE job_id IS NOT NULL DO NOTHING
       RETURNING ${deployColumns}`,
      [
        input.projectId,
        input.jobId,
        input.kind,
        input.helmRevision,
        input.targetRevision ?? null,
        input.status,
        input.lastError ?? null,
        input.ref ?? null,
      ],
    );
    if (result.rows[0]) return mapDeploy(result.rows[0]);

    const existing = await this.db.query<ProjectDeployRow>(
      `SELECT ${deployColumns} FROM project_deploys WHERE job_id = $1`,
      [input.jobId],
    );
    return mapDeploy(existing.rows[0]);
  }

  /**
   * The git ref recorded for a revision this project produced, or null.
   *
   * Used by the rollback route, where the job carries no ref of its own: a
   * rollback applies no new commit, so the only honest answer to "which commit
   * is deployed" afterwards is the one the target revision was deployed from.
   */
  async refForRevision(projectId: string, revision: number): Promise<string | null> {
    const result = await this.db.query<{ ref: string | null }>(
      `SELECT ref
       FROM project_deploys
       WHERE project_id = $1
         AND helm_revision = $2
         AND status = 'completed'
       ORDER BY created_at DESC
       LIMIT 1`,
      [projectId, revision],
    );
    return result.rows[0]?.ref ?? null;
  }

  /**
   * A project's deploy history, newest first. Bounded because the page only
   * ever renders a recent window; there is no pagination cursor yet (see
   * ADR 022's follow-ups).
   */
  async listForProject(projectId: string, limit = 50): Promise<ProjectDeploy[]> {
    const result = await this.db.query<ProjectDeployRow>(
      `SELECT ${deployColumns}
       FROM project_deploys
       WHERE project_id = $1
       ORDER BY created_at DESC, helm_revision DESC NULLS LAST
       LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map(mapDeploy);
  }

  /**
   * The revision currently live: the newest entry that actually produced a
   * revision. A failed attempt leaves helm_revision NULL and so is skipped,
   * which is what makes this correct without consulting the cluster — the
   * ledger is the record of what Yggdrasil applied, in order.
   */
  async currentRevision(projectId: string): Promise<number | null> {
    const result = await this.db.query<{ helm_revision: number | null }>(
      `SELECT helm_revision
       FROM project_deploys
       WHERE project_id = $1
         AND helm_revision IS NOT NULL
         AND status = 'completed'
       ORDER BY created_at DESC, helm_revision DESC
       LIMIT 1`,
      [projectId],
    );
    return result.rows[0]?.helm_revision ?? null;
  }

  /**
   * The revisions this project can roll back to, newest first, excluding
   * whatever is currently live (rolling back to the current revision is a
   * no-op, so offering it would be noise).
   *
   * DISTINCT on helm_revision because a revision can appear more than once:
   * a rollback replays an older revision's content as a new revision number,
   * and repeated rollbacks between the same two states produce repeated
   * content under different numbers — only the numbers matter here.
   */
  async listRollbackTargets(projectId: string): Promise<RollbackTarget[]> {
    const result = await this.db.query<{
      helm_revision: number;
      created_at: Date;
      kind: ProjectDeployKind;
    }>(
      `SELECT DISTINCT ON (helm_revision)
              helm_revision, created_at, kind
       FROM project_deploys
       WHERE project_id = $1
         AND helm_revision IS NOT NULL
         AND status = 'completed'
       ORDER BY helm_revision DESC, created_at DESC`,
      [projectId],
    );

    const current = await this.currentRevision(projectId);
    return result.rows
      .filter((row) => row.helm_revision !== current)
      .map((row) => ({
        revision: row.helm_revision,
        deployedAt: row.created_at,
        kind: row.kind,
      }));
  }

  /**
   * Whether the given revision is one this project produced, so the API can
   * reject a rollback to a revision that does not exist before enqueueing a
   * job. Guards against a client posting an arbitrary integer, and against a
   * stale UI offering a target that has since been pruned.
   */
  async hasRevision(projectId: string, revision: number): Promise<boolean> {
    const result = await this.db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM project_deploys
         WHERE project_id = $1
           AND helm_revision = $2
           AND status = 'completed'
       ) AS exists`,
      [projectId, revision],
    );
    return result.rows[0]?.exists ?? false;
  }
}
