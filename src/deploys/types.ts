/**
 * ADR 022: the per-project deploy ledger. One row per deploy or rollback that
 * reached a terminal state, written by the Orchestrator after the Helm
 * operation, so a project can show what is running and offer a way back to an
 * earlier revision.
 */

/** Which operation produced a ledger row. `rollback` is a distinct job kind. */
export type ProjectDeployKind = "deploy" | "rollback";

/** Terminal outcome only — a ledger row is written when the operation ends. */
export type ProjectDeployStatus = "completed" | "failed";

export interface ProjectDeploy {
  id: string;
  projectId: string;
  jobId: string | null;
  kind: ProjectDeployKind;
  /**
   * The Helm revision this operation produced. Null when it produced none
   * (a failed attempt). Not the same as targetRevision: a rollback creates a
   * new revision rather than rewinding to the target.
   */
  helmRevision: number | null;
  /** Set only for a rollback: the earlier revision the operator asked for. */
  targetRevision: number | null;
  status: ProjectDeployStatus;
  lastError: string | null;
  /** Git ref the job carried, when it had one. */
  ref: string | null;
  createdAt: Date;
}

export interface PublicProjectDeploy {
  id: string;
  jobId: string | null;
  kind: ProjectDeployKind;
  helmRevision: number | null;
  targetRevision: number | null;
  status: ProjectDeployStatus;
  lastError: string | null;
  ref: string | null;
  createdAt: string;
}

export function toPublicProjectDeploy(deploy: ProjectDeploy): PublicProjectDeploy {
  return {
    id: deploy.id,
    jobId: deploy.jobId,
    kind: deploy.kind,
    helmRevision: deploy.helmRevision,
    targetRevision: deploy.targetRevision,
    status: deploy.status,
    lastError: deploy.lastError,
    ref: deploy.ref,
    createdAt: deploy.createdAt.toISOString(),
  };
}

/**
 * A revision an operator can roll back to. Derived from the ledger rather than
 * from Helm history directly, so the offered targets are exactly the revisions
 * this project actually produced through Yggdrasil.
 */
export interface RollbackTarget {
  revision: number;
  /** When that revision was deployed. */
  deployedAt: Date;
  /** The deploy kind that produced it — useful to explain "this was itself a rollback". */
  kind: ProjectDeployKind;
}
