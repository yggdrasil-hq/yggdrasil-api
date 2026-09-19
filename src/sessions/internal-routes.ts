import { Router, raw } from "express";
import type express from "express";
import { config } from "../config.js";
import type { JobRepository } from "../jobs/repository.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { formatByteSize, resolveExpiry } from "../shared/artifacts.js";
import { isUuid } from "../shared/uuid.js";
import type { JobSessionRepository } from "./repository.js";
import {
  isSessionOutcome,
  rejectSessionUpload,
  sessionState,
  SESSION_CONTENT_TYPE,
} from "./retention.js";
import { toPublicJobSession } from "./types.js";

/**
 * ADR 032 item 1's upload endpoint: the Orchestrator posts the Pi session file it
 * read out of a job pod before the pod is deleted.
 *
 * ## The shape, and why each part of it is what it is
 *
 * **Raw body, not JSON.** A session is JSONL text, but a long grill is megabytes
 * (Pi appends tool results verbatim), so base64-in-JSON would inflate it by a third
 * for nothing — and the app-wide `express.json` parser's 2 MB limit would reject a
 * real session before this handler ever ran. `express.raw` is scoped to this one
 * route, so a session-sized limit does not become the limit everywhere else. The
 * matching rule is `PostJobRecording`'s, with the sizes shifted down.
 *
 * **The small fields ride as query parameters**, because the body is already spoken
 * for — the same arrangement `PostJobScreenshot` uses for `stepName`. `?outcome=` is
 * required and is *not* optional: ADR 032 item 5's whole requirement is that "this
 * run has no session" and "this run's session could not be retrieved" stay apart,
 * and the only thing that distinguishes them is the outcome the collector reported.
 * A default would be the bug.
 *
 * **Called on every run, including failures.** The Orchestrator makes this call
 * whether or not it collected anything, and that is deliberate on both sides: a
 * route reached only on success cannot express item 5's distinction. So an empty
 * body is a normal, expected request shape here rather than a malformed one.
 *
 * ## Why a rejected artifact is a 202 and never a 4xx
 *
 * An oversized session, a `collected` outcome with no bytes, or an install with
 * collection switched off all get a 202 with the reason attached: the Orchestrator
 * logs it and finishes the job normally (ADR 029's rule for recordings, which ADR
 * 032 item 1 follows). A 4xx here would tempt the caller into treating an artifact
 * problem as a job error, and an artifact must never fail a run.
 *
 * Not written to the audit trail, matching ADR 028 item 7's rule that
 * `/internal/*` Orchestrator-driven writes are out of scope — there is no human
 * actor to attribute.
 */
export function createSessionsInternalRouter(deps: {
  jobs: JobRepository;
  sessions: JobSessionRepository;
}): Router {
  const router = Router();

  router.post(
    "/jobs/:jobId/session",
    requireInternalApiToken,
    raw({
      // The Orchestrator's own media type, stated explicitly so an unexpected
      // Content-Type is not silently parsed as it.
      type: [SESSION_CONTENT_TYPE],
      // The real policy cap rather than a multiple of it, so an arbitrarily large
      // upload is rejected without being buffered. The cost is that the parser,
      // not this handler, is what notices an over-limit body — handled by the error
      // middleware below, which is why that middleware is load-bearing.
      limit: config.sessions.maxBytes > 0 ? config.sessions.maxBytes : 1,
    }),
    async (req, res) => {
      const jobId = routeParam(req.params.jobId);
      if (!isUuid(jobId)) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const job = await deps.jobs.findById(jobId);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      /*
       * The outcome is validated before anything else, because every later decision
       * depends on it — and an unrecognised one must not be coerced into a
       * plausible default. A typo'd or future outcome reaching the insert would
       * either fail the table's CHECK (a 500 for the Orchestrator, which would then
       * log a fault rather than a refusal) or, worse, be silently mapped onto
       * `unavailable` and tell a user their session could not be retrieved when
       * nothing was ever asked. A 202 keeps the caller's contract: it logs a reason
       * and finishes the job.
       */
      const outcome = String(req.query.outcome ?? "");
      if (!isSessionOutcome(outcome)) {
        res.status(202).json({
          stored: false,
          reason: `Unrecognised session outcome: ${outcome === "" ? "(missing)" : outcome}`,
        });
        return;
      }

      // ADR 032 item 1 scopes this to the grill, which is the only kind that
      // collects a session (`internal/worker/specgrill.go`) — so a session posted
      // for anything else is a misconfiguration worth surfacing rather than storing.
      // A design session is a grill too but is out of scope here, so it is refused
      // by the same branch rather than by silence.
      if (job.kind !== "spec_grill") {
        res.status(202).json({
          stored: false,
          reason: "This job kind does not collect a session",
        });
        return;
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const rejection = rejectSessionUpload({
        outcome,
        byteSize: body.byteLength,
        maxBytes: config.sessions.maxBytes,
      });
      if (rejection) {
        res.status(202).json({ stored: false, reason: rejection });
        return;
      }

      // Anchored to the job's own start rather than to "now at upload time", so a
      // long run does not silently get a longer window than a short one and a
      // re-post cannot extend its own life. Same rule as recordings.
      const createdAt = job.startedAt ?? job.createdAt;
      const session = await deps.sessions.upsert({
        jobId: job.id,
        projectId: job.projectId,
        outcome,
        // Empty query values are absent, not empty strings: the column's job is to
        // say whether Pi reported an id, and "" would be a third state meaning
        // nothing.
        sessionId: stringOrNull(req.query.sessionId),
        podFilePath: stringOrNull(req.query.podFilePath),
        data: outcome === "collected" ? body : null,
        expiresAt: outcome === "collected"
          ? resolveExpiry(createdAt, config.sessions.retentionDays)
          : null,
      });

      res.status(201).json({
        stored: true,
        session: toPublicJobSession({
          jobId: job.id,
          session,
          // The same rule the read path uses, rather than a second expression of
          // it — the upload response and a later GET must not be able to disagree
          // about the state of the thing they both describe.
          state: sessionState(
            {
              outcome: session.outcome,
              hasData: session.outcome === "collected",
              expiresAt: session.expiresAt,
              purgedAt: session.purgedAt,
            },
            new Date(),
          ),
          canFork: session.outcome === "collected",
        }),
      });
    },
  );

  /**
   * Turns the body parser's own rejection into the same non-fatal shape this
   * handler uses for every other refusal.
   *
   * This is load-bearing rather than tidiness, exactly as it is for recordings:
   * `express.raw` aborts an over-limit body with a 413 *before* the route handler
   * runs, so without this the one case that most needs the "never fails the job"
   * contract would be the case that breaks it — the Orchestrator would see a 4xx
   * and an oversized session would surface as a failed run rather than a skipped
   * artifact. The true size is unknowable here (the body was aborted mid-stream), so
   * the reason names the configured limit instead.
   *
   * A cap of zero is reported as collection being off rather than as an
   * over-limit artifact, because that is what it means — the parser's limit is a
   * placeholder 1 byte in that configuration, and "exceeds 1 B" would be a
   * misleading thing to hand an operator.
   *
   * Anything that is not a body-parsing failure is passed straight through, so a
   * genuine error is never masked into a 2xx.
   */
  router.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const status =
        (error as { status?: number; statusCode?: number } | null)?.status ??
        (error as { statusCode?: number } | null)?.statusCode;
      if (status === 413) {
        res.status(202).json({
          stored: false,
          reason:
            config.sessions.maxBytes > 0
              ? `Session exceeds the ${formatByteSize(config.sessions.maxBytes)} limit`
              : "Session collection is switched off",
        });
        return;
      }
      next(error);
    },
  );

  return router;
}

/** A query parameter's value, or null when it was absent or empty. */
function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

