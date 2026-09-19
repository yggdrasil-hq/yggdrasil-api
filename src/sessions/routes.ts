import { Router } from "express";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import { UserRepository } from "../users/repository.js";
import type { JobSessionRepository } from "./repository.js";
import { permitsFork, sessionState, UNKNOWN_SESSION_STATE } from "./retention.js";
import { sessionStateExplanation, toPublicJobSession } from "./types.js";

/**
 * ADR 032's read side: what became of one job's Pi session.
 *
 * Addressed by **job id**, not by feature id, following `recordings/routes.ts` and
 * for the same reasons: a session belongs to one run, the run already has a stable
 * id in every URL the Web app builds, and the job is then resolved *through the
 * project* so another project's job id is a 404 rather than a readable artifact.
 *
 * ## Why the metadata route never 404s for a missing session
 *
 * `GET .../session` answers 200 with a `state` even when there is no session at all,
 * for the same reason the recording metadata route answers `{recording: null}`:
 * "this run did not save a session" is a normal answer the Spec page needs in order
 * to render, not an error. Collapsing it into a 404 would push the caller into
 * treating an ordinary outcome as a failure, and the four non-available states are
 * precisely the information ADR 032 item 5 exists to deliver.
 *
 * ## Where the bytes are served from
 *
 * Behind the ordinary session cookie and the same project-access check as every
 * other project read — deliberately not from a public object-storage URL, matching
 * `recordings/routes.ts`'s reasoning. A session holds the **full** conversation,
 * including anything the transcript redacts or abbreviates (ADR 032's own
 * trade-offs call this out: the retention window is a data-retention decision, not
 * only a storage one), so it must be no more reachable than the transcript it
 * belongs to.
 *
 * The route exists rather than the bytes being write-only. That is not a nicety: a
 * storage layer nothing can read is indistinguishable from not storing at all, and
 * ADR 024's follow-up criticism of the shipped rewind is exactly that its discarded
 * conversation is "currently write-only". The fork ADR 032 item 3 describes reads
 * through the repository server-side; this route is how the artifact is inspectable
 * by the people already authorized to read its transcript.
 */

/**
 * The artifact is immutable once stored (a re-upload replaces it, but a run does
 * not re-record), so a short *private* window is safe and avoids re-sending
 * megabytes. `private` is the load-bearing word — no shared proxy may cache what an
 * authorized browser fetched.
 */
const CONTENT_CACHE_SECONDS = 300;

export function createSessionsRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  projects: ProjectRepository;
  jobs: JobRepository;
  jobSessions: JobSessionRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  /**
   * Resolves the job only if the caller can read the project it belongs to. Every
   * failure — malformed uuid, no access, no such job, job in another project — is
   * one 404, so this route cannot be used to probe which job ids exist.
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

  router.get(
    "/:projectId/jobs/:jobId/session",
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

      const session = await deps.jobSessions.findByJob(job.id);
      /*
       * No row means **unknown**, not `not_collected`, and the difference is a claim
       * rather than a wording: a `not_collected` row is the Orchestrator reporting
       * that Pi answered and produced no session, whereas no row says only that this
       * API was never told anything — an install with collection switched off
       * produces this and never the other. Naming it correctly is item 5's
       * requirement; the explanation is what the UI shows.
       */
      const state = session
        ? sessionState(
            {
              outcome: session.outcome,
              // A collected row's bytes are available unless a tombstone says
              // otherwise. The live-object-missing case still reads as available
              // here and 404s at the content route, which is the honest split: this
              // route reports what was recorded, that one what can be fetched.
              hasData: session.outcome === "collected",
              expiresAt: session.expiresAt,
              purgedAt: session.purgedAt,
            },
            new Date(),
          )
        : UNKNOWN_SESSION_STATE;

      res.json({
        session: toPublicJobSession({
          jobId: job.id,
          session,
          state,
          canFork: permitsFork(state),
        }),
        explanation: sessionStateExplanation(state),
      });
    },
  );

  /**
   * The bytes.
   *
   * Two different failure modes, deliberately given different statuses, following
   * the recording route:
   *
   * - **404** — nothing was ever stored for this run (no row, a failing outcome, or
   *   a live object the bucket has lost). "We do not have this" is the truth in all
   *   three cases, and none of them is a tombstone.
   * - **410 Gone** — a session was stored and its bytes were reclaimed by retention.
   *   Not a 404, because the artifact is not missing; it is *finished*. A client
   *   that conflates the two renders an expired session as a broken link, which is
   *   the failure this distinction exists to prevent.
   */
  router.get(
    "/:projectId/jobs/:jobId/session/content",
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

      const session = await deps.jobSessions.findContent(job.id);
      if (!session) {
        res.status(404).json({ error: "No session for this run" });
        return;
      }

      const state = sessionState(
        {
          outcome: session.outcome,
          // `data !== null` rather than trusting `purged_at` alone: the table's
          // CHECK keeps the two in lockstep, and this stays honest even if a future
          // migration relaxes it — the same choice the recording route makes.
          hasData: session.data !== null,
          expiresAt: session.expiresAt,
          purgedAt: session.purgedAt,
        },
        new Date(),
      );
      if (state === "expired" || session.data === null) {
        // A failing outcome is not a tombstone, so it is answered from its own
        // state rather than being reported as reclaimed.
        if (session.outcome !== "collected") {
          res.status(404).json({ error: sessionStateExplanation(session.outcome) });
          return;
        }
        res.status(410).json({
          error: "This session was removed after its retention window",
        });
        return;
      }

      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Content-Length", String(session.data.byteLength));
      // `attachment` rather than `inline`: a session is megabytes of raw JSONL that
      // no browser renders, so the useful behaviour is to save it. (Recordings say
      // `inline` for the opposite reason — they are the artifact you watch.)
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("Cache-Control", `private, max-age=${CONTENT_CACHE_SECONDS}`);
      // The artifact is a session transcript; `nosniff` keeps a browser from
      // re-deciding that its bytes are something executable.
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(session.data);
    },
  );

  return router;
}
