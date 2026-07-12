export type JobKind = "spec_grill" | "feature_build" | "test_run" | "deploy";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  featureId: string | null;
  testId: string | null;
  status: JobStatus;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}
