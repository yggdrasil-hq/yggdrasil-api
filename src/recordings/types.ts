import type { RecordingContentType, RecordingState } from "./retention.js";

/**
 * ADR 029: one job's screen recording.
 *
 * `data` is nullable rather than the row simply being deleted when retention
 * runs out, which is the whole reason this shape exists: a purged recording
 * must remain *distinguishable* from one that was never captured, so the UI can
 * say "this recording was removed after its retention window" instead of
 * rendering an empty player for a run that did record. See `retention.ts`'s
 * `RecordingState`.
 */
export interface JobRecording {
  jobId: string;
  projectId: string;
  contentType: RecordingContentType;
  byteSize: number;
  expiresAt: Date;
  purgedAt: Date | null;
  createdAt: Date;
}

/** A recording plus its bytes — only fetched by the download path. */
export interface JobRecordingContent extends JobRecording {
  data: Buffer | null;
}

/**
 * What the Web app is told about a recording. Deliberately carries no path and
 * no bytes: the artifact is fetched from its own endpoint, so a run-history
 * response never balloons to the size of the video it describes.
 *
 * `state` is computed server-side from the same pure function the sweeper's
 * predicate mirrors, so the client cannot drift from the server about whether
 * an artifact is still there.
 */
export interface PublicJobRecording {
  jobId: string;
  state: RecordingState;
  contentType: RecordingContentType;
  byteSize: number;
  expiresAt: string;
  purgedAt: string | null;
  createdAt: string;
}

export function toPublicJobRecording(
  recording: JobRecording,
  state: RecordingState,
): PublicJobRecording {
  return {
    jobId: recording.jobId,
    state,
    contentType: recording.contentType,
    byteSize: recording.byteSize,
    expiresAt: recording.expiresAt.toISOString(),
    purgedAt: recording.purgedAt?.toISOString() ?? null,
    createdAt: recording.createdAt.toISOString(),
  };
}
