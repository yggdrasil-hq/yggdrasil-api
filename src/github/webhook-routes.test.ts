import { describe, expect, it, vi } from "vitest";
import {
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  handlePushEvent,
} from "./webhook-routes.js";

function makePayload(overrides: Partial<{ ref: string; owner: string; repo: string }> = {}) {
  return {
    ref: overrides.ref ?? "refs/heads/main",
    repository: {
      name: overrides.repo ?? "web",
      owner: { login: overrides.owner ?? "acme" },
    },
  };
}

describe("handlePushEvent", () => {
  it("dispatches a deploy job for a push to main on a ready project's primary repo", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const projects = {
      findByPrimaryRepository: vi.fn().mockResolvedValue({ id: "proj_1", status: "ready" }),
    };
    const jobs = { create: dispatch };

    await handlePushEvent(makePayload(), { projects: projects as never, jobs: jobs as never });

    expect(projects.findByPrimaryRepository).toHaveBeenCalledWith("acme", "web");
    expect(dispatch).toHaveBeenCalledWith({ projectId: "proj_1", kind: "deploy" });
  });

  it("ignores pushes to branches other than main", async () => {
    const dispatch = vi.fn();
    const projects = { findByPrimaryRepository: vi.fn() };

    await handlePushEvent(makePayload({ ref: "refs/heads/feature-x" }), {
      projects: projects as never,
      jobs: { create: dispatch } as never,
    });

    expect(projects.findByPrimaryRepository).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ignores pushes for repos that aren't any project's primary repo", async () => {
    const dispatch = vi.fn();
    const projects = { findByPrimaryRepository: vi.fn().mockResolvedValue(null) };

    await handlePushEvent(makePayload(), {
      projects: projects as never,
      jobs: { create: dispatch } as never,
    });

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ignores pushes for a project still initializing", async () => {
    const dispatch = vi.fn();
    const projects = {
      findByPrimaryRepository: vi.fn().mockResolvedValue({ id: "proj_1", status: "initializing" }),
    };

    await handlePushEvent(makePayload(), {
      projects: projects as never,
      jobs: { create: dispatch } as never,
    });

    expect(dispatch).not.toHaveBeenCalled();
  });
});

function makePrPayload(
  overrides: Partial<{ action: string; htmlUrl: string; merged: boolean }> = {},
) {
  return {
    action: overrides.action ?? "closed",
    pull_request: {
      html_url: overrides.htmlUrl ?? "https://github.com/acme/web/pull/42",
      merged: overrides.merged ?? true,
    },
  };
}

describe("handlePullRequestEvent", () => {
  it("marks a normal feature merged when its tracked PR is merged, without touching deploy", async () => {
    const updateStatus = vi.fn().mockResolvedValue(null);
    const features = {
      findByPrUrl: vi.fn().mockResolvedValue({
        id: "feat_1",
        projectId: "proj_1",
        featureType: "normal",
        status: "in_review",
      }),
      updateStatus,
    };
    const projects = { findById: vi.fn(), markReady: vi.fn() };
    const jobs = { create: vi.fn() };

    await handlePullRequestEvent(makePrPayload(), {
      features: features as never,
      projects: projects as never,
      jobs: jobs as never,
    });

    expect(features.findByPrUrl).toHaveBeenCalledWith("https://github.com/acme/web/pull/42");
    expect(updateStatus).toHaveBeenCalledWith("feat_1", "merged");
    expect(projects.findById).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("marks the project ready and dispatches its first deploy when a project_init feature's PR merges", async () => {
    const updateStatus = vi.fn().mockResolvedValue(null);
    const markReady = vi.fn().mockResolvedValue(undefined);
    const features = {
      findByPrUrl: vi.fn().mockResolvedValue({
        id: "feat_1",
        projectId: "proj_1",
        featureType: "project_init",
        status: "in_review",
      }),
      updateStatus,
    };
    const projects = {
      findById: vi.fn().mockResolvedValue({ id: "proj_1", status: "initializing" }),
      markReady,
    };
    const jobs = { create: vi.fn().mockResolvedValue({ id: "job_1" }) };

    await handlePullRequestEvent(makePrPayload(), {
      features: features as never,
      projects: projects as never,
      jobs: jobs as never,
    });

    expect(updateStatus).toHaveBeenCalledWith("feat_1", "merged");
    expect(markReady).toHaveBeenCalledWith("proj_1");
    expect(jobs.create).toHaveBeenCalledWith({ projectId: "proj_1", kind: "deploy" });
  });

  it("resolves a parent's subtask Action Item when a subtask feature merges (ADR 015 item 5)", async () => {
    const updateStatus = vi.fn().mockResolvedValue(null);
    const resolveSubtaskItem = vi.fn().mockResolvedValue(undefined);
    const features = {
      findByPrUrl: vi.fn().mockResolvedValue({
        id: "feat_2",
        projectId: "proj_1",
        featureType: "normal",
        status: "in_review",
        parentFeatureId: "feat_1",
      }),
      updateStatus,
    };
    const projects = { findById: vi.fn() };
    const jobs = { create: vi.fn() };
    const actionItems = { resolveSubtaskItem };

    await handlePullRequestEvent(makePrPayload(), {
      features: features as never,
      projects: projects as never,
      jobs: jobs as never,
      actionItems: actionItems as never,
    });

    expect(updateStatus).toHaveBeenCalledWith("feat_2", "merged");
    expect(resolveSubtaskItem).toHaveBeenCalledWith("feat_2");
  });

  it("does not dispatch deploy for a project_init merge when the project is already ready", async () => {
    const updateStatus = vi.fn().mockResolvedValue(null);
    const markReady = vi.fn();
    const features = {
      findByPrUrl: vi.fn().mockResolvedValue({
        id: "feat_1",
        projectId: "proj_1",
        featureType: "project_init",
        status: "in_review",
      }),
      updateStatus,
    };
    const projects = {
      findById: vi.fn().mockResolvedValue({ id: "proj_1", status: "ready" }),
      markReady,
    };
    const jobs = { create: vi.fn() };

    await handlePullRequestEvent(makePrPayload(), {
      features: features as never,
      projects: projects as never,
      jobs: jobs as never,
    });

    expect(markReady).not.toHaveBeenCalled();
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it("ignores a PR closed without merging", async () => {
    const updateStatus = vi.fn();
    const features = { findByPrUrl: vi.fn(), updateStatus };
    const projects = { findById: vi.fn(), markReady: vi.fn() };
    const jobs = { create: vi.fn() };

    await handlePullRequestEvent(makePrPayload({ merged: false }), {
      features: features as never,
      projects: projects as never,
      jobs: jobs as never,
    });

    expect(features.findByPrUrl).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("ignores actions other than closed", async () => {
    const updateStatus = vi.fn();
    const features = { findByPrUrl: vi.fn(), updateStatus };
    const projects = { findById: vi.fn(), markReady: vi.fn() };
    const jobs = { create: vi.fn() };

    await handlePullRequestEvent(makePrPayload({ action: "opened" }), {
      features: features as never,
      projects: projects as never,
      jobs: jobs as never,
    });

    expect(features.findByPrUrl).not.toHaveBeenCalled();
  });

  it("ignores a merge for a PR that doesn't match any tracked feature", async () => {
    const updateStatus = vi.fn();
    const features = { findByPrUrl: vi.fn().mockResolvedValue(null), updateStatus };
    const projects = { findById: vi.fn(), markReady: vi.fn() };
    const jobs = { create: vi.fn() };

    await handlePullRequestEvent(makePrPayload(), {
      features: features as never,
      projects: projects as never,
      jobs: jobs as never,
    });

    expect(updateStatus).not.toHaveBeenCalled();
  });

  it("is idempotent for a feature already marked merged", async () => {
    const updateStatus = vi.fn();
    const features = {
      findByPrUrl: vi.fn().mockResolvedValue({
        id: "feat_1",
        projectId: "proj_1",
        featureType: "normal",
        status: "merged",
      }),
      updateStatus,
    };
    const projects = { findById: vi.fn(), markReady: vi.fn() };
    const jobs = { create: vi.fn() };

    await handlePullRequestEvent(makePrPayload(), {
      features: features as never,
      projects: projects as never,
      jobs: jobs as never,
    });

    expect(updateStatus).not.toHaveBeenCalled();
  });
});

function makeReviewPayload(
  overrides: Partial<{ action: string; state: string; htmlUrl: string }> = {},
) {
  return {
    action: overrides.action ?? "submitted",
    review: { state: overrides.state ?? "changes_requested" },
    pull_request: { html_url: overrides.htmlUrl ?? "https://github.com/acme/web/pull/42" },
  };
}

describe("handlePullRequestReviewEvent", () => {
  it("moves an in_review feature to returned (human_review) on changes_requested", async () => {
    const setReturned = vi.fn().mockResolvedValue(null);
    const features = {
      findByPrUrl: vi.fn().mockResolvedValue({ id: "feat_1", status: "in_review" }),
      setReturned,
    };

    await handlePullRequestReviewEvent(makeReviewPayload(), { features: features as never });

    expect(setReturned).toHaveBeenCalledWith("feat_1", "human_review", expect.any(String));
  });

  it("returns early when the review state is not changes_requested", async () => {
    const setReturned = vi.fn();
    const features = {
      findByPrUrl: vi.fn().mockResolvedValue({ id: "feat_1", status: "in_review" }),
      setReturned,
    };

    await handlePullRequestReviewEvent(makeReviewPayload({ state: "approved" }), {
      features: features as never,
    });

    expect(setReturned).not.toHaveBeenCalled();
  });

  it("does not clobber a feature that has already moved past in_review", async () => {
    const setReturned = vi.fn();
    const features = {
      findByPrUrl: vi.fn().mockResolvedValue({ id: "feat_1", status: "merged" }),
      setReturned,
    };

    await handlePullRequestReviewEvent(makeReviewPayload(), { features: features as never });

    expect(setReturned).not.toHaveBeenCalled();
  });
});
