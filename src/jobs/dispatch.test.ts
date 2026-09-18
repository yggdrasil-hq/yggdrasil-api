import { describe, expect, it, vi } from "vitest";
import {
  ONE_ACTIVE_DEPLOY_INDEX,
  dispatchDeployJob,
  isActiveDeployConflict,
} from "./dispatch.js";

/**
 * Issue #26: the route's "is a deployment already in flight?" check is a
 * check-then-act, so it cannot see a concurrent request's insert. The database
 * can — migration 043's partial unique index — and the loser of that race has
 * to be told, not shown a 500.
 */

function uniqueViolation(constraint: string): unknown {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint,
  });
}

describe("isActiveDeployConflict", () => {
  it("recognises the one-active-deploy index", () => {
    expect(isActiveDeployConflict(uniqueViolation(ONE_ACTIVE_DEPLOY_INDEX))).toBe(true);
  });

  it("recognises nothing else", () => {
    // A different unique violation is a data problem, and reporting it as
    // "a deployment is already in progress" would send the operator looking for
    // a job that does not exist.
    expect(isActiveDeployConflict(uniqueViolation("some_other_index"))).toBe(false);
    // An undefined constraint is the shape a non-pg error takes, and a
    // connection failure must not read as a conflict either.
    expect(isActiveDeployConflict(new Error("connection terminated"))).toBe(false);
    expect(isActiveDeployConflict(undefined)).toBe(false);
    expect(isActiveDeployConflict("23505")).toBe(false);
  });
});

describe("dispatchDeployJob", () => {
  it("returns the created job", async () => {
    const job = { id: "job_1" };
    const jobs = { create: vi.fn(async () => job) };

    const result = await dispatchDeployJob(jobs as never, {
      projectId: "proj_1",
      kind: "deploy",
      ref: "main",
    });

    expect(result).toEqual({ job });
    expect(jobs.create).toHaveBeenCalledWith({
      projectId: "proj_1",
      kind: "deploy",
      ref: "main",
    });
  });

  it("reports a conflict instead of throwing when another request won the race", async () => {
    const jobs = {
      create: vi.fn(async () => {
        throw uniqueViolation(ONE_ACTIVE_DEPLOY_INDEX);
      }),
    };

    const result = await dispatchDeployJob(jobs as never, {
      projectId: "proj_1",
      kind: "rollback",
      targetRevision: 3,
    });

    expect(result).toEqual({ conflict: true });
  });

  it("propagates an unrelated failure", async () => {
    const jobs = {
      create: vi.fn(async () => {
        throw new Error("connection terminated");
      }),
    };

    await expect(
      dispatchDeployJob(jobs as never, { projectId: "proj_1", kind: "deploy" }),
    ).rejects.toThrow("connection terminated");
  });
});
