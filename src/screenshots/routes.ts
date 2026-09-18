import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import { artifactState } from "../shared/artifacts.js";
import { UserRepository } from "../users/repository.js";
import type { JobScreenshotRepository } from "./repository.js";
import { toPublicJobScreenshot } from "./types.js";

/**
 * Issue #22's authenticated read side: a run's screenshots, and one screenshot's
 * bytes.
 *
 * Mirrors `recordings/routes.ts` deliberately, including its authorization
 * shape — every failure is one 404, so these routes cannot be used to probe
 * which job ids exist — and its decision to serve bytes from **this API behind
 * the ordinary session cookie** rather than from a public URL. A screenshot of a
 * real test session can contain real customer data on screen; it has no reason
 * to be reachable by anyone who cannot already read the run it belongs to, which
 * is the same reasoning that kept recordings off object storage (and is a
 * deliberate contrast with ADR 003 §15's public previews, issue #20).
 *
 * Addressed by job id for the listing and by `(jobId, screenshotId)` for the
 * bytes, so a screenshot from another project's run is a 404 rather than a
 * readable artifact.
 */

/**
 * Bytes are streamed with an explicit `Cache-Control: private`. A screenshot is
 * immutable once stored (a re-upload replaces it, but the URL is per-artifact and
 * a run does not re-shoot a step), so a short private window avoids re-sending
 * the image on every expand. `private` is the load-bearing word: no shared proxy
 * may cache what an authorized browser fetched.
 */
const CONTENT_CACHE_SECONDS = 300;

export function createScreenshotsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  jobs: JobRepository;
  screenshots: JobScreenshotRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  /** As in the recordings router: one 404 covers every reason a job is unreadable. */
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
   * A run's screenshots, in report order.
   *
   * Answers 200 with `{ screenshots: [] }` when the run produced none, rather
   * than 404 — "this run has no screenshots" is a normal answer the UI must
   * render, not an error. Tombstoned rows are included with `state: "expired"`,
   * so a purged screenshot is visibly reclaimed rather than simply absent.
   */
  router.get(
    "/:projectId/jobs/:jobId/screenshots",
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

      const now = new Date();
      const screenshots = await deps.screenshots.listForJob(job.id);
      res.json({
        screenshots: screenshots.map((screenshot) =>
          toPublicJobScreenshot(
            screenshot,
            // `listForJob` never selects the bytes, so presence is inferred from
            // the tombstone stamp — which the table's CHECK constraint keeps in
            // lockstep with `data IS NULL` (see the migration). Reading
            // `purgedAt` here is therefore exactly as honest as reading the
            // bytes would be, without pulling images into memory to list them.
            artifactState(
              {
                expiresAt: screenshot.expiresAt,
                purgedAt: screenshot.purgedAt,
                hasData: screenshot.purgedAt === null,
              },
              now,
            ),
          ),
        ),
      });
    },
  );

  /**
   * One screenshot's bytes.
   *
   * Two different failure modes, deliberately given different statuses — the
   * same distinction the recordings router makes, and for the same reason:
   *
   * - **404** — no such screenshot for this job (never captured, or another
   *   project's).
   * - **410 Gone** — a screenshot existed and its bytes were reclaimed by
   *   retention. Not a 404, because the artifact is not missing; it is
   *   *finished*. A client that conflates the two renders an expired screenshot
   *   as a broken image, which is the failure this feature exists to prevent.
   */
  router.get(
    "/:projectId/jobs/:jobId/screenshots/:screenshotId/content",
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

      const screenshotId = routeParam(req.params.screenshotId);
      // A malformed id is a 404 like any other unreadable artifact, so this route
      // cannot distinguish "bad shape" from "not yours".
      if (!isUuid(screenshotId)) {
        res.status(404).json({ error: "Screenshot not found" });
        return;
      }

      const screenshot = await deps.screenshots.findContent(job.id, screenshotId);
      if (!screenshot) {
        res.status(404).json({ error: "No such screenshot for this run" });
        return;
      }

      const state = artifactState(
        {
          expiresAt: screenshot.expiresAt,
          purgedAt: screenshot.purgedAt,
          hasData: screenshot.data !== null,
        },
        new Date(),
      );
      if (state === "expired" || screenshot.data === null) {
        res.status(410).json({
          error: "This screenshot was removed after its retention window",
        });
        return;
      }

      res.setHeader("Content-Type", screenshot.contentType);
      res.setHeader("Content-Length", String(screenshot.data.byteLength));
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", `private, max-age=${CONTENT_CACHE_SECONDS}`);
      // The artifact is immutable and the content type is whitelisted to
      // browser-renderable, script-free image formats. `nosniff` is the belt to
      // that braces: it keeps a browser from re-deciding that image bytes are
      // something executable, which is the failure mode an SVG upload would have
      // been.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(screenshot.data);
    },
  );

  return router;
}
