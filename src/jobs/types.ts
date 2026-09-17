export type JobKind =
  | "spec_grill"
  | "feature_build"
  | "test_run"
  | "deploy"
  | "script_test_run"
  | "agentic_review"
  | "design_grill"
  | "rollback";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  featureId: string | null;
  testId: string | null;
  testGroup: "unit" | "integration" | null;
  ref: string | null;
  trigger: "feature" | "schedule" | null;
  designName: string | null;
  designSlug: string | null;
  designDescription: string | null;
  specContext: Record<string, unknown> | null;
  status: JobStatus;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /**
   * The Helm revision a `rollback` job should roll the primary release back
   * to (ADR 022). Null for every other kind. Pinned here at request time so a
   * queued rollback keeps the revision the operator chose even if newer
   * deploys land before it is claimed.
   */
  targetRevision: number | null;
}
