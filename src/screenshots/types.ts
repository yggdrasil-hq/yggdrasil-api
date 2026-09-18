import type { ScreenshotContentType, ScreenshotState } from "./retention.js";

/**
 * Issue #22: one step's screenshot.
 *
 * `data` is nullable rather than the row being deleted when retention runs out,
 * matching `JobRecording` and for the same reason: a purged screenshot must
 * remain *distinguishable* from one that was never captured, so the UI can say
 * "this screenshot was removed after its retention window" instead of rendering
 * a broken image for a step that did capture one.
 */
export interface JobScreenshot {
  id: string;
  jobId: string;
  projectId: string;
  stepName: string;
  contentType: ScreenshotContentType;
  byteSize: number;
  expiresAt: Date;
  purgedAt: Date | null;
  createdAt: Date;
}

/** A screenshot plus its bytes — only fetched by the download path. */
export interface JobScreenshotContent extends JobScreenshot {
  data: Buffer | null;
}

/**
 * What the Web app is told about a screenshot. Deliberately carries no bytes and
 * no in-pod path: the artifact is fetched from its own endpoint by `id`, so a
 * run-history response never balloons to the size of the images it describes.
 *
 * `state` is computed server-side from the same shared rule the sweeper's
 * predicate mirrors, so the client cannot drift from the server about whether an
 * artifact is still there.
 */
export interface PublicJobScreenshot {
  id: string;
  stepName: string;
  state: ScreenshotState;
  contentType: ScreenshotContentType;
  byteSize: number;
  expiresAt: string;
  purgedAt: string | null;
  createdAt: string;
}

export function toPublicJobScreenshot(
  screenshot: JobScreenshot,
  state: ScreenshotState,
): PublicJobScreenshot {
  return {
    id: screenshot.id,
    stepName: screenshot.stepName,
    state,
    contentType: screenshot.contentType,
    byteSize: screenshot.byteSize,
    expiresAt: screenshot.expiresAt.toISOString(),
    purgedAt: screenshot.purgedAt?.toISOString() ?? null,
    createdAt: screenshot.createdAt.toISOString(),
  };
}
