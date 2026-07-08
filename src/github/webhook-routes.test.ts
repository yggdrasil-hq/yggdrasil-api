import { describe, expect, it, vi } from "vitest";
import { handlePushEvent } from "./webhook-routes.js";

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
