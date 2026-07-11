import { Router } from "express";
import { z } from "zod";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { FeatureRepository } from "../features/repository.js";
import type { JobEventRepository } from "./events-repository.js";
import type { JobRepository } from "./repository.js";

const jobEventSchema = z.object({
  type: z.enum([
    "agent_text",
    "ask_user",
    "submit_adr",
    "run_failed",
    "run_cancelled",
    "submit_build_result",
  ]),
  question: z.string().optional(),
  markdown: z.string().optional(),
  message: z.string().optional(),
  status: z.string().optional(),
  prUrl: z.string().optional(),
  summary: z.string().optional(),
});

/**
 * Accepts curated events the Orchestrator relays from a running job's Pi
 * RPC session (ADR 006 items 7-8) and persists them — the only place job
 * events enter the API. Read-side (WebSocket relay to the Web app,
 * notifications) is a tracked follow-up.
 */
export function createJobsInternalRouter(deps: {
  jobEvents: JobEventRepository;
  jobs: JobRepository;
  features: FeatureRepository;
}): Router {
  const router = Router();

  router.post(
    "/jobs/:jobId/events",
    requireInternalApiToken,
    async (req, res) => {
      const jobId = routeParam(req.params.jobId);
      if (!isUuid(jobId)) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const parsed = jobEventSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid event" });
        return;
      }

      let event;
      try {
        event = await deps.jobEvents.create({ jobId, ...parsed.data });
      } catch (error) {
        console.error(`failed to record event for job ${jobId}:`, error);
        res.status(500).json({ error: "Failed to record job event" });
        return;
      }

      await syncFeatureState(deps, jobId, parsed.data);
      res.status(201).json({ id: event.id });
    },
  );

  return router;
}

/**
 * Reacts to the event just persisted by updating the feature it belongs to
 * (ADR 006 items 10-11; ADR 010 item 9): `ask_user` sets
 * `awaiting_user_input`, so the API/Web app can tell a grill is paused on a
 * human. `submit_adr` is spec_grill's successful terminal event: it stores
 * the submitted markdown and moves the feature `draft` -> `spec_ready`
 * (`FeatureRepository.setSpecReady`, which also clears
 * `awaiting_user_input` itself). `submit_build_result` is feature_build's
 * single terminal event, carrying its own outcome in `status`: `"success"`
 * moves the feature to `in_review` and persists the opened PR's URL
 * (`FeatureRepository.setInReview`); `"failure"` is handled exactly like
 * `run_failed` below. `run_failed`/`run_cancelled` are the run's
 * unsuccessful terminal events: each clears `awaiting_user_input` (so a job
 * that stops — dies, or is deliberately cancelled, ADR 006 item 13 — while
 * still waiting on a reply doesn't leave the flag stuck true forever) and
 * moves the feature to `failed`/`cancelled` respectively (ADR 007 item 8's
 * retry-grill route depends on a `project_init` feature actually reaching
 * `failed`, not staying on `draft` forever) — without this, the Web app has
 * no way to tell a grill died. feature_build never sets
 * `awaiting_user_input` true in the first place (its implement skill has no
 * ask_user tool, ADR 010), so `submit_build_result` doesn't touch it either
 * way, unlike run_failed/run_cancelled which unconditionally clear it.
 *
 * Best-effort: a failure here doesn't undo the 201 already sent for the
 * event itself, since the event was persisted successfully regardless.
 */
async function syncFeatureState(
  deps: { jobs: JobRepository; features: FeatureRepository },
  jobId: string,
  event: Pick<z.infer<typeof jobEventSchema>, "type" | "markdown" | "status" | "prUrl">,
): Promise<void> {
  if (
    event.type !== "ask_user" &&
    event.type !== "run_failed" &&
    event.type !== "run_cancelled" &&
    event.type !== "submit_adr" &&
    event.type !== "submit_build_result"
  ) {
    return;
  }
  try {
    const job = await deps.jobs.findById(jobId);
    if (!job?.featureId) {
      return;
    }
    if (event.type === "submit_adr") {
      await deps.features.setSpecReady(job.featureId, event.markdown ?? "");
      return;
    }
    if (event.type === "submit_build_result") {
      if (event.status === "success") {
        await deps.features.setInReview(job.featureId, event.prUrl ?? "");
      } else {
        await deps.features.updateStatus(job.featureId, "failed");
      }
      return;
    }
    await deps.features.setAwaitingUserInput(job.featureId, event.type === "ask_user");
    if (event.type === "run_failed") {
      await deps.features.updateStatus(job.featureId, "failed");
    } else if (event.type === "run_cancelled") {
      await deps.features.updateStatus(job.featureId, "cancelled");
    }
  } catch (error) {
    console.error(`failed to sync feature state for job ${jobId}:`, error);
  }
}
