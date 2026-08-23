import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import express from "express";
import { config, isGitHubAppConfigured } from "../config.js";
import type { FeatureRepository } from "../features/repository.js";
import { dispatchJob } from "../jobs/dispatch.js";
import type { JobRepository } from "../jobs/repository.js";
import type { ProjectRepository } from "../projects/repository.js";
import { GithubInstallationRepository } from "./installation-repository.js";
import { syncInstallationFromGitHub } from "./sync-installation.js";

function verifyWebhookSignature(payload: string, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) {
    return false;
  }
  const expected = createHmac("sha256", config.github.appWebhookSecret)
    .update(payload)
    .digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  if (expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}

interface WebhookInstallation {
  id: number;
  account?: {
    id: number;
    login: string;
    type: "Organization" | "User";
  };
}

interface WebhookPayload {
  action: string;
  installation?: WebhookInstallation;
  repositories_added?: Array<{ full_name: string; id: number }>;
  repositories_removed?: Array<{ full_name: string; id: number }>;
}

interface PushWebhookPayload {
  ref: string;
  repository: {
    name: string;
    owner: { login: string };
  };
}

interface PullRequestWebhookPayload {
  action: string;
  pull_request: {
    html_url: string;
    merged: boolean;
  };
}

interface PullRequestReviewWebhookPayload {
  action: string;
  review: {
    state: string;
  };
  pull_request: {
    html_url: string;
  };
}

const MAIN_BRANCH_REF = "refs/heads/main";

/**
 * Enqueues a `deploy` job when a push lands on the primary repo's `main`
 * branch of a project that has finished `project_init` (ADR 003 §9-13).
 */
export async function handlePushEvent(
  payload: PushWebhookPayload,
  deps: { projects: ProjectRepository; jobs: JobRepository },
): Promise<void> {
  if (payload.ref !== MAIN_BRANCH_REF || !payload.repository) {
    return;
  }
  const project = await deps.projects.findByPrimaryRepository(
    payload.repository.owner.login,
    payload.repository.name,
  );
  if (project && project.status === "ready") {
    await dispatchJob(deps.jobs, { projectId: project.id, kind: "deploy" });
  }
}

/**
 * Advances a feature to `merged` when its tracked draft PR is merged on
 * GitHub (ADR 013), closing the gap ADR 005 §19 explicitly deferred
 * ("feature lifecycle advances manually in Yggdrasil"). Matched by PR URL
 * (`FeatureRepository.findByPrUrl`) since the payload carries no feature
 * id. A `closed` action with `merged: false` (PR closed without merging)
 * is left alone — that doesn't necessarily mean the feature was abandoned,
 * and there's no lifecycle state for it yet.
 */
export async function handlePullRequestEvent(
  payload: PullRequestWebhookPayload,
  deps: { features: FeatureRepository; projects: ProjectRepository; jobs: JobRepository },
): Promise<void> {
  if (payload.action !== "closed" || !payload.pull_request.merged) {
    return;
  }
  const feature = await deps.features.findByPrUrl(payload.pull_request.html_url);
  if (!feature || feature.status === "merged") {
    return;
  }
  await deps.features.updateStatus(feature.id, "merged");

  // Mirrors POST /:projectId/complete-init (routes.ts) — a project_init
  // feature merging is what completes project setup, and until now that
  // only ever happened via the manual "complete-init" button.
  if (feature.featureType === "project_init") {
    const project = await deps.projects.findById(feature.projectId);
    if (project && project.status === "initializing") {
      await deps.projects.markReady(project.id);
      // Deliberately dispatched here, not left to the sibling `push`
      // webhook for this same merge commit: that handler only dispatches
      // `deploy` when `project.status === "ready"` already, and delivery
      // order between the two webhooks isn't guaranteed — if `push`
      // happens to be processed first, it would silently no-op (GitHub
      // doesn't redeliver), and the project's always-on deployment would
      // never get its first `deploy` job at all (ADR 013 addendum).
      await dispatchJob(deps.jobs, { projectId: project.id, kind: "deploy" });
    }
  }
}

/**
 * Moves a feature `in_review -> changes_requested` when a reviewer
 * requests changes on its tracked PR (ADR 013). Only fires from
 * `in_review`: a stale/duplicate review event shouldn't clobber a status
 * that has already moved on (e.g. `merged`, `queued` from a re-run).
 */
export async function handlePullRequestReviewEvent(
  payload: PullRequestReviewWebhookPayload,
  deps: { features: FeatureRepository },
): Promise<void> {
  if (payload.action !== "submitted" || payload.review.state !== "changes_requested") {
    return;
  }
  const feature = await deps.features.findByPrUrl(payload.pull_request.html_url);
  if (!feature || feature.status !== "in_review") {
    return;
  }
  await deps.features.updateStatus(feature.id, "changes_requested");
}

export function createGitHubWebhookRouter(deps: {
  installations: GithubInstallationRepository;
  projects: ProjectRepository;
  jobs: JobRepository;
  features: FeatureRepository;
}): Router {
  const router = Router();

  router.post(
    "/github",
    express.raw({ type: "application/json" }),
    async (req: Request, res) => {
      if (!isGitHubAppConfigured() || !config.github.appWebhookSecret) {
        res.status(503).json({ error: "GitHub App webhooks are not configured" });
        return;
      }

      const signature = req.header("x-hub-signature-256");
      const payload =
        typeof req.body === "string"
          ? req.body
          : Buffer.isBuffer(req.body)
            ? req.body.toString("utf8")
            : "";

      if (!verifyWebhookSignature(payload, signature)) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }

      const event = req.header("x-github-event");
      const data = JSON.parse(payload) as WebhookPayload;

      try {
        if (event === "installation") {
          const installationId = data.installation?.id;
          if (!installationId) {
            res.status(202).send();
            return;
          }

          if (data.action === "deleted" || data.action === "suspend") {
            await deps.installations.markSuspended(installationId);
            const record = await deps.installations.findByGithubInstallationId(installationId);
            if (record) {
              await deps.installations.setProjectsAccessWarningForInstallation(record.id, true);
            }
          } else if (data.action === "created" || data.action === "unsuspend") {
            await syncInstallationFromGitHub(deps.installations, installationId, null);
          }
        }

        if (event === "push") {
          await handlePushEvent(data as unknown as PushWebhookPayload, deps);
        }

        if (event === "pull_request") {
          await handlePullRequestEvent(data as unknown as PullRequestWebhookPayload, deps);
        }

        if (event === "pull_request_review") {
          await handlePullRequestReviewEvent(
            data as unknown as PullRequestReviewWebhookPayload,
            deps,
          );
        }

        if (event === "installation_repositories") {
          const installationId = data.installation?.id;
          if (!installationId) {
            res.status(202).send();
            return;
          }

          const record = await syncInstallationFromGitHub(
            deps.installations,
            installationId,
            null,
          );

          if (data.action === "removed" && data.repositories_removed) {
            for (const repo of data.repositories_removed) {
              await deps.installations.setProjectAccessWarningForRepo(
                record.id,
                repo.full_name,
              );
            }
          } else {
            await deps.installations.clearProjectAccessWarningsIfReposGranted(record.id);
          }
        }

        res.status(202).send();
      } catch (error) {
        console.error("GitHub webhook handler error:", error);
        res.status(500).json({ error: "Webhook processing failed" });
      }
    },
  );

  return router;
}
