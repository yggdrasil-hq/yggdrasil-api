import { Router, json, raw } from "express";
import type express from "express";
import { config } from "../config.js";
import type { JobRepository } from "../jobs/repository.js";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { formatByteSize, resolveExpiry } from "../shared/artifacts.js";
import { isUuid } from "../shared/uuid.js";
import type { JobSessionRepository } from "./repository.js";
import {
  isForkPointOutcome,
  isSessionOutcome,
  rejectForkPointUpload,
  rejectSessionUpload,
  sessionState,
  SESSION_CONTENT_TYPE,
  type ForkPointOutcome,
} from "./retention.js";
import { toPublicJobSession, type ForkPoint } from "./types.js";

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
          // The upload response reports the run's fork points too, because it is
          // the same question ("what became of this run's session") and a client
          // comparing an upload response against a later GET must not see two
          // different shapes for it.
          forkPoints: await deps.sessions.findForkPoints(job.id),
        }),
      });
    },
  );

  /**
   * ADR 032 item 2's capture: which previous user messages a finished job's session
   * can be forked from.
   *
   * ## Why this is a second route rather than a field on the session post
   *
   * The session route's body is the raw JSONL artifact, and that is load-bearing:
   * a session is routinely megabytes (Pi appends tool results verbatim), so it is
   * the body precisely so base64-in-JSON cannot inflate it by a third — and the
   * route carries its own `raw` parser at the artifact cap rather than going through
   * the JSON parser. A fork-point list is structured and variable-length, so it
   * cannot ride as a query parameter and cannot share that body without one of the
   * two being corrupted. (A multipart body would carry both, at the cost of a
   * parser dependency this deployment cannot install, for one field.)
   *
   * ## Why that is safe, and what it costs
   *
   * A second call can fail independently, so a run can end up with a stored session
   * and no fork-point report. That absence is *why* `outcome` is stored and why no
   * row maps to `unknown`: a missing report reads as "nobody found out", never as
   * "there are none". The cost is one extra round trip and one more failure mode the
   * Orchestrator logs and continues past — the same best-effort posture every
   * artifact post here has, since a capture must never fail the run that produced it.
   *
   * ## Why the outcome travels in the body rather than in the query string
   *
   * The session route puts its small fields in the query because its body is spoken
   * for by the artifact. Here the body is JSON and the outcome belongs beside the
   * points it describes, so that a reader of the payload sees the claim and its
   * evidence together rather than having to correlate a URL with a body.
   */
  router.post(
    "/jobs/:jobId/session/fork-points",
    requireInternalApiToken,
    // The parser is declared **on this route** rather than relied on from the app,
    // for the reason the session route declares `raw()` on itself: this router is
    // mounted in tests and in production, and a route whose request parsing depends
    // on what its host happened to install is a route that behaves differently in the
    // two. (`app.ts` does install `express.json()` globally; a mount without it made
    // every body here arrive unparsed, which is how this was found.)
    //
    // The limit is this payload's own, not the session artifact's: a fork-point list
    // is one short string per human reply — kilobytes for the chattiest grill that
    // could exist — so a limit in the artifact's range would be describing a body
    // this endpoint cannot receive.
    (req, res, next) => {
      forkPointsJsonParser(req, res, (error?: unknown) => {
        // A parser rejection is answered in this router's own non-fatal shape rather
        // than left to the shared 413 middleware below, whose wording names a
        // *session* limit — and a reason an operator cannot act on is worse than no
        // reason. Same contract as the session route: the Orchestrator logs it and
        // finishes the job normally.
        if (error) {
          res.status(202).json({
            stored: false,
            reason: `Fork points exceed the ${formatByteSize(FORK_POINTS_MAX_BYTES)} limit`,
          });
          return;
        }
        next();
      });
    },
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

      // The same scoping the session post applies, and for the same reason: ADR 032
      // scopes session collection to the grill, so fork points for anything else are
      // a misconfiguration worth surfacing rather than storing. A design session is
      // a grill too and is out of scope, so it is refused by this branch rather than
      // by silence.
      if (job.kind !== "spec_grill") {
        res.status(202).json({
          stored: false,
          reason: "This job kind does not collect a session",
        });
        return;
      }

      const body: unknown = req.body;
      const parsed = parseForkPointBody(body);
      if ("reason" in parsed) {
        res.status(202).json({ stored: false, reason: parsed.reason });
        return;
      }

      const rejection = rejectForkPointUpload({
        outcome: parsed.outcome,
        pointCount: parsed.points?.length ?? 0,
      });
      if (rejection) {
        res.status(202).json({ stored: false, reason: rejection });
        return;
      }

      await deps.sessions.upsertForkPoints(
        job.id,
        parsed.outcome,
        parsed.points ?? null,
      );

      res.status(201).json({
        stored: true,
        // Read back rather than echoing the request: the response then states what
        // is *stored*, which is the thing a caller comparing it against a later GET
        // can rely on.
        forkPoints: await deps.sessions.findForkPoints(job.id),
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

/**
 * The bound on a fork-points body (ADR 032 item 2).
 *
 * Sized from what the payload actually is — one short string per human reply in a
 * grill — rather than borrowed from the session artifact's cap: a grill with a
 * hundred replies at a few kilobytes each is still well under this, and a limit in
 * the megabytes would describe a body this endpoint has no reason to expect.
 *
 * Deliberately a property of the *transport* and not of policy: unlike the session
 * cap there is no configuration for it, because there is no operator decision in it
 * — a fork-point list too large to store is a bug in the capture, not a deployment
 * choice about how much to keep.
 */
const FORK_POINTS_MAX_BYTES = 256_000;

/**
 * The fork-points route's own JSON parser.
 *
 * Built once, outside the request path: `json()` returns a configured middleware,
 * and constructing one per request would allocate a parser on every capture.
 */
const forkPointsJsonParser = json({ limit: FORK_POINTS_MAX_BYTES });

/**
 * Decodes a fork-points body, or a reason it cannot be stored.
 *
 * Returns a reason rather than throwing, matching every other refusal in this
 * router: the Orchestrator logs it and finishes the job normally, because a capture
 * must never fail the run that produced it.
 *
 * **An entry with no usable `entryId` is a refusal, not a silent drop.** `fork` is
 * sent the id and Pi rejects an unknown one outright, so a stored point with an
 * empty id would be offered to a user and then refuse them. (The Orchestrator's
 * parser drops such entries before they get this far, so this is the second line —
 * worth having because this route is the trust boundary, and a hand-written request
 * never passed through that parser.) An empty `text` is allowed: it is display only,
 * and Pi is the only source for it.
 *
 * `outcome: "unavailable"` deliberately accepts **no** points, mirroring the
 * session route's rule that a failing outcome cannot carry a body: a caller must not
 * be able to store points while claiming not to know whether points exist.
 */
function parseForkPointBody(
  body: unknown,
): { outcome: ForkPointOutcome; points: ForkPoint[] | null } | { reason: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { reason: "A fork-points body must be a JSON object" };
  }

  const { outcome, points } = body as { outcome?: unknown; points?: unknown };
  if (typeof outcome !== "string" || !isForkPointOutcome(outcome)) {
    return {
      reason: `Unrecognised fork-points outcome: ${typeof outcome === "string" && outcome !== "" ? outcome : "(missing)"}`,
    };
  }

  if (outcome === "unavailable") {
    // Present-but-empty is accepted and normalised away, because JSON has no way to
    // distinguish ``absent`` from `[]` for a caller that serialises uniformly, and
    // refusing that would be refusing a shape rather than a claim.
    if (Array.isArray(points) && points.length > 0) {
      return { reason: `An outcome of "unavailable" cannot carry fork points` };
    }
    return { outcome, points: null };
  }

  if (!Array.isArray(points)) {
    return { reason: `A "captured" outcome must carry a points array` };
  }

  const parsed: ForkPoint[] = [];
  for (const point of points) {
    if (typeof point !== "object" || point === null) {
      return { reason: "Each fork point must be an object with an entryId" };
    }
    const { entryId, text } = point as { entryId?: unknown; text?: unknown };
    const id = stringOrNull(entryId);
    if (id === null) {
      return { reason: "Each fork point must have a non-empty entryId" };
    }
    parsed.push({ entryId: id, text: typeof text === "string" ? text : "" });
  }
  return { outcome, points: parsed };
}

