import { describe, expect, it } from "vitest";
import { earlierGrillRuns, type FeatureGrillRun } from "./grill-runs.js";

/**
 * Issue #28 part 2's two rules, tested as rules.
 *
 * The cases that matter are the ones where "earlier" and "superseded" come apart,
 * because conflating them is the easy mistake: a run can be earlier without
 * anything having been discarded (ADR 012's retry), and the supersession link has
 * to survive the current run being the one that did the rewinding.
 */

const at = (iso: string) => new Date(iso);

function run(overrides: Partial<FeatureGrillRun> = {}): FeatureGrillRun {
  return {
    jobId: "job-1",
    status: "completed",
    createdAt: at("2026-09-01T10:00:00Z"),
    restartedFromEventId: null,
    supersedesJobId: null,
    ...overrides,
  };
}

describe("earlierGrillRuns", () => {
  it("returns nothing for a feature that has never been grilled", () => {
    expect(earlierGrillRuns([])).toEqual([]);
  });

  it("returns nothing when there is only the current run", () => {
    // The first grill has no predecessor, so there is nothing to offer — and the
    // current run itself must not appear, or the page would offer to "re-read" the
    // conversation already on screen.
    expect(earlierGrillRuns([run({ jobId: "only" })])).toEqual([]);
  });

  it("lists the earlier run, newest first", () => {
    const runs = earlierGrillRuns([
      run({ jobId: "a", createdAt: at("2026-09-01T10:00:00Z") }),
      run({ jobId: "b", createdAt: at("2026-09-02T10:00:00Z") }),
      run({ jobId: "c", createdAt: at("2026-09-03T10:00:00Z") }),
    ]);

    expect(runs.map((r) => r.jobId)).toEqual(["b", "a"]);
  });

  /**
   * The distinction the whole module turns on. `a` is replaced by `b`, but `b` was
   * a **retry** (`restartedFromEventId` null), not a rewind — so nothing of `a`'s
   * conversation was discarded, and claiming it was superseded would assert a loss
   * that never happened.
   */
  it("does not call a run superseded merely because a later one exists", () => {
    const runs = earlierGrillRuns([
      run({ jobId: "a" }),
      // `b` has no `restartedFromEventId`: a retry, so it superseded nothing.
      run({ jobId: "b", createdAt: at("2026-09-02T10:00:00Z") }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].jobId).toBe("a");
    expect(runs[0].supersededByJobId).toBeNull();
  });

  it("links a run to the later one that rewound from it", () => {
    const runs = earlierGrillRuns([
      run({ jobId: "a" }),
      run({
        jobId: "b",
        createdAt: at("2026-09-02T10:00:00Z"),
        restartedFromEventId: "event-in-a",
        supersedesJobId: "a",
      }),
    ]);

    expect(runs).toEqual([
      {
        jobId: "a",
        status: "completed",
        createdAt: "2026-09-01T10:00:00.000Z",
        restartedFromEventId: null,
        supersededByJobId: "b",
      },
    ]);
  });

  /**
   * The case a naive "the next run superseded this one" implementation gets wrong,
   * and it is the one a user is most likely to be looking for: the *most recent*
   * rewind was performed by the run that is now current, so the link has to be
   * built from the current run too, not only from the ones being listed.
   */
  it("attributes a rewind performed by the current run", () => {
    const runs = earlierGrillRuns([
      run({ jobId: "a" }),
      run({
        jobId: "b",
        createdAt: at("2026-09-02T10:00:00Z"),
        restartedFromEventId: "event-in-a",
        supersedesJobId: "a",
      }),
      run({
        jobId: "current",
        createdAt: at("2026-09-03T10:00:00Z"),
        restartedFromEventId: "event-in-b",
        supersedesJobId: "b",
      }),
    ]);

    expect(runs.map((r) => [r.jobId, r.supersededByJobId])).toEqual([
      ["b", "current"],
      ["a", "b"],
    ]);
  });

  /**
   * `restarted_from_event_id` is `ON DELETE SET NULL`, so a job survives its target
   * event being removed — which means a run can be produced by a rewind while the
   * run it rewound is no longer resolvable. That is a real state, not a defensive
   * one, and it must not break the list.
   */
  it("lists a run whose rewound-from event no longer resolves", () => {
    const runs = earlierGrillRuns([
      run({ jobId: "a" }),
      run({
        jobId: "b",
        createdAt: at("2026-09-02T10:00:00Z"),
        restartedFromEventId: "event-that-was-deleted",
        supersedesJobId: null,
      }),
    ]);

    expect(runs.map((r) => r.jobId)).toEqual(["a"]);
    // `a` gets no link: nothing resolvable says it was rewound.
    expect(runs[0].supersededByJobId).toBeNull();
  });

  it("carries status and the rewind source through, so a reader can describe the run", () => {
    const runs = earlierGrillRuns([
      run({ jobId: "a", status: "failed" }),
      run({
        jobId: "b",
        createdAt: at("2026-09-02T10:00:00Z"),
        restartedFromEventId: "event-in-a",
        supersedesJobId: "a",
        status: "cancelled",
      }),
    ]);

    expect(runs[0]).toMatchObject({
      status: "failed",
      // The *earlier* run's own rewind source — null here, because `a` was the
      // feature's first grill. Distinct from `supersededByJobId`, and both are
      // needed: one says how this run came to exist, the other how it ended.
      restartedFromEventId: null,
      supersededByJobId: "b",
    });
  });
});
