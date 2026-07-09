import { Router } from "express";
import { z } from "zod";
import { requireInternalApiToken } from "../secrets/internal-auth.js";
import { routeParam } from "../shared/route-param.js";
import { isUuid } from "../shared/uuid.js";
import type { FeatureRepository } from "../features/repository.js";
import type { JobEventRepository } from "./events-repository.js";
import type { JobRepository } from "./repository.js";

const jobEventSchema = z.object({
  type: z.enum(["agent_text", "ask_user", "submit_adr", "run_failed", "run_cancelled"]),
  question: z.string().optional(),
  markdown: z.string().optional(),
  message: z.string().optional(),
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

      await syncAwaitingUserInput(deps, jobId, parsed.data.type);
      res.status(201).json({ id: event.id });
    },
  );

  return router;
}

/**
 * Flips the job's feature's `awaiting_user_input` flag (ADR 006 item 10) in
 * reaction to the event just persisted: `ask_user` sets it, so the API/Web
 * app can tell a grill is paused on a human; `run_failed`/`run_cancelled`
 * both clear it, so a job that stops (dies, or is deliberately cancelled —
 * ADR 006's cancel/abort follow-up, item 13) while still waiting on a reply
 * doesn't leave the flag stuck true forever (the reply endpoint,
 * `projects/routes.ts`, is what clears it on the success path). `submit_adr`
 * needs no handling here — by the time a run reaches it, any prior
 * `ask_user` has already been resolved by a reply, which already cleared
 * the flag.
 *
 * Best-effort: a failure here doesn't undo the 201 already sent for the
 * event itself, since the event was persisted successfully regardless.
 */
async function syncAwaitingUserInput(
  deps: { jobs: JobRepository; features: FeatureRepository },
  jobId: string,
  eventType: z.infer<typeof jobEventSchema>["type"],
): Promise<void> {
  if (eventType !== "ask_user" && eventType !== "run_failed" && eventType !== "run_cancelled") {
    return;
  }
  try {
    const job = await deps.jobs.findById(jobId);
    if (!job?.featureId) {
      return;
    }
    await deps.features.setAwaitingUserInput(job.featureId, eventType === "ask_user");
  } catch (error) {
    console.error(`failed to sync awaiting_user_input for job ${jobId}:`, error);
  }
}
