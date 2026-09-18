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
  /**
   * How the job came to exist. `manual` is a person pressing "Run now" on a Test
   * (issue #31) — deliberately not folded into `schedule`, which would attribute
   * a deliberate run to the scheduler in the history the field exists to explain.
   */
  trigger: "feature" | "schedule" | "manual" | null;
  designName: string | null;
  designSlug: string | null;
  designDescription: string | null;
  /** The `designs` row this session works on (ADR 020); null for every other kind. */
  designId: string | null;
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
  /**
   * ADR 024: the `job_events` turn this run's seed context was rewound to,
   * when the run came from a per-message "restart from here" rather than a
   * first attempt or an ADR 015 kickback. Null for every other run.
   *
   * Exists so a restarted session is identifiable from the job alone: the seed
   * itself is in `specContext`, which is deliberately never exposed publicly
   * (it can carry a whole previous ADR and transcript).
   */
  restartedFromEventId: string | null;
}
