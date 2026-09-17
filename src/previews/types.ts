/**
 * ADR 003 §10/§15/§17: ephemeral preview deployments — one per preview-eligible
 * job, reachable at a per-run subdomain, torn down when the job ends.
 *
 * This is the API's registry of them. It exists so the cap can be enforced when
 * a job is claimed, so a crashed run's leftover environment can be swept, and
 * so the Web app can link to a live preview without inventing a URL.
 */

/** Only `active` occupies a slot in ADR 003 §17's per-project cap. */
export type PreviewStatus = "active" | "torn_down" | "failed";

export interface JobPreview {
  id: string;
  projectId: string;
  jobId: string;
  host: string;
  status: PreviewStatus;
  lastError: string | null;
  createdAt: Date;
  tornDownAt: Date | null;
}

export interface PublicJobPreview {
  jobId: string;
  /**
   * Bare hostname, as reported by the Orchestrator (which owns preview
   * identity — see internal/preview). The Web app composes the scheme; storing
   * a full URL here would bake a scheme choice into a row that outlives it.
   */
  host: string;
  status: PreviewStatus;
  lastError: string | null;
  createdAt: string;
  tornDownAt: string | null;
}

export function toPublicJobPreview(preview: JobPreview): PublicJobPreview {
  return {
    jobId: preview.jobId,
    host: preview.host,
    status: preview.status,
    lastError: preview.lastError,
    createdAt: preview.createdAt.toISOString(),
    tornDownAt: preview.tornDownAt?.toISOString() ?? null,
  };
}

/** A preview the Orchestrator should try to remove (see the stale endpoint). */
export interface StalePreview {
  jobId: string;
  projectId: string;
  host: string;
}
