import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import { UserRepository } from "../users/repository.js";
import type { JobRecordingRepository } from "./repository.js";
import { recordingState } from "./retention.js";
import { toPublicJobRecording } from "./types.js";

/**
 * ADR 029's read side: a job's screen recording, and its metadata.
 *
 * Addressed by **job id**, not by test id. A recording belongs to one run, the
 * run already has a stable id in every URL the Web app builds, and keying on it
 * means this router needs no opinion about tests, features, or which job kinds
 * appear in which list. The job is then resolved *through the project* so
 * another project's job id is a 404 rather than a readable artifact.
 *
 * ## Where the bytes are served from, and why it matters
 *
 * Recordings are streamed by **this API, behind the ordinary session cookie**,
 * and never from public object storage. That is a deliberate contrast with
 * ADR 003 §15's preview deployments, which are public by decision (see issue
 * #20): a preview is the project's own application at a URL the team is meant
 * to share, whereas a recording is a film of a real session — it can contain
 * real customer data on screen and real credentials as they are typed into a
 * form. Putting that on an unguessable-but-public URL would be a materially
 * different exposure than the preview decision accepted, and the artifact has
 * no reason to be reachable by anyone who is not already able to read the run
 * it belongs to. So the authorization is exactly the project-access check every
 * other project read uses, and there is no separate unauthenticated URL.
 *
 * (`Content-Disposition: inline` rather than `attachment`: the point is to
 * watch it in the run-history view, and the UI is the only intended consumer.)
 */

/**
 * Bytes are streamed with an explicit `Cache-Control: private` — a recording is
 * immutable once stored (a re-upload replaces it, but the URL is per-job and a
 * run does not re-record), so a short private window is safe and avoids
 * re-sending megabytes on every expand. `private` is the load-bearing word:
 * no shared proxy may cache what an authorized browser fetched.
 */
const CONTENT_CACHE_SECONDS = 300;

export function createRecordingsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  jobs: JobRepository;
  recordings: JobRecordingRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  /**
   * Resolves the job only if the caller can read the project it belongs to.
   * Every failure — malformed uuid, no access, no such job, job in another
   * project — is one 404, so this route cannot be used to probe which job ids
   * exist.
   */
  async function resolveJob(
    req: Parameters<typeof requireAuth>[0],
    projectId: string,
    jobId: string,
  ) {
    if (!isUuid(projectId) || !isUuid(jobId)) return null;
    const user = req.currentUser;
    if (!user) return null;
    const project = await deps.projects.findByIdForUser(projectId, user.id);
    if (!project) return null;
    return deps.jobs.findByIdForProject(project.id, jobId);
  }

  /**
   * Metadata for a run's recording. Answers 200 with `{ recording: null }` when
   * the run never produced one, rather than 404 — "this run was not recorded"
   * is a normal, expected answer the UI needs to render, not an error.
   *
   * The state is computed here from the stored facts (see `retention.ts`), so
   * the client is told `expired` explicitly instead of inferring it from a
   * timestamp and its own clock.
   */
  router.get(
    "/:projectId/jobs/:jobId/recording",
    requireAuth,
    async (req, res) => {
      const job = await resolveJob(
        req,
        routeParam(req.params.projectId),
        routeParam(req.params.jobId),
      );
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const recording = await deps.recordings.findByJob(job.id);
      if (!recording) {
        res.json({ recording: null });
        return;
      }

      const state = recordingState(
        {
          expiresAt: recording.expiresAt,
          purgedAt: recording.purgedAt,
          hasData: true,
        },
        new Date(),
      );
      res.json({ recording: toPublicJobRecording(recording, state) });
    },
  );

  /**
   * The bytes.
   *
   * Two different failure modes, deliberately given different statuses:
   *
   * - **404** — no recording was ever stored for this job.
   * - **410 Gone** — a recording existed and its bytes were reclaimed by
   *   retention. This is not a 404, because the artifact is not missing; it is
   *   *finished*. A client that conflates the two renders an expired recording
   *   as a broken link, which is the failure ADR 029 item 6 exists to prevent.
   *
   * Note `findContent` reports `hasData: recording.data !== null` rather than
   * trusting `purged_at` alone: the row's CHECK constraint keeps the two in
   * lockstep, and this stays honest even if a future migration relaxes it.
   */
  router.get(
    "/:projectId/jobs/:jobId/recording/content",
    requireAuth,
    async (req, res) => {
      const job = await resolveJob(
        req,
        routeParam(req.params.projectId),
        routeParam(req.params.jobId),
      );
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const recording = await deps.recordings.findContent(job.id);
      if (!recording) {
        res.status(404).json({ error: "No recording for this run" });
        return;
      }

      const state = recordingState(
        {
          expiresAt: recording.expiresAt,
          purgedAt: recording.purgedAt,
          hasData: recording.data !== null,
        },
        new Date(),
      );
      if (state === "expired" || recording.data === null) {
        res.status(410).json({
          error: "This recording was removed after its retention window",
        });
        return;
      }

      res.setHeader("Content-Type", recording.contentType);
      res.setHeader("Content-Length", String(recording.data.byteLength));
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", `private, max-age=${CONTENT_CACHE_SECONDS}`);
      // The artifact is immutable; `nosniff` keeps a browser from re-deciding
      // that video bytes are something executable.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(recording.data);
    },
  );

  return router;
}
