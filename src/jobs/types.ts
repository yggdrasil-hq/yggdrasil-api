export type JobKind =
  | "spec_grill"
  | "feature_build"
  | "test_run"
  | "deploy"
  | "script_test_run"
  | "agentic_review"
  | "design_grill";
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
  status: JobStatus;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
