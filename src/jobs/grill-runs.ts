import type { JobStatus } from "./types.js";

/**
 * ADR 024 item 8 / issue #28 part 2: a feature's `spec_grill` runs, so a rewind
 * can be *read back*.
 *
 * **Why this exists.** Each rewind dispatches a new `spec_grill` job (ADR 012's
 * "a new row every time, the old one preserved as history") and truncates the
 * earlier conversation into its seed. The earlier run therefore still exists in
 * `jobs` + `job_events` — but nothing could reach it: the only feature events
 * route resolves `findLatestJob(featureId)`, i.e. one job, the newest. So the
 * product stored the discarded work and offered no way to see it, and a user who
 * rewound by mistake had no path to what they lost. ADR 024's own trade-offs
 * record exactly that.
 *
 * This module owns the two rules the feature needs, so the API answers them once
 * rather than each client re-deriving them from a payload it happens to receive:
 *
 * 1. **what counts as "earlier"**, and
 * 2. **which run superseded which**.
 *
 * Both are pure and separately tested. The rules are the substance; the SQL below
 * them just fetches the rows they operate on.
 */

/**
 * One `spec_grill` run of a feature, as read from `jobs`.
 *
 * The repository returns this rather than a plain `Job` because the list needs one
 * fact a `Job` does not carry on its own: **which run this one rewound**, which is
 * a join through `restarted_from_event_id` (migration 037). A purpose-built read
 * type mirrors `TestRunHistoryEntry` and `RollbackTarget` — the shape a specific
 * screen needs, not the full entity.
 */
export interface FeatureGrillRun {
  jobId: string;
  status: JobStatus;
  createdAt: Date;
  /**
   * Set when this run was produced by a rewind: the transcript event it was
   * seeded from, which lives in an **earlier** job.
   *
   * Null for a run that was not produced by a rewind — the feature's first grill,
   * or one created by ADR 012's retry.
   */
  restartedFromEventId: string | null;
  /**
   * The job whose transcript this run rewound, resolved by looking up
   * `restartedFromEventId` in `job_events`. Null whenever
   * `restartedFromEventId` is null, and also when that event no longer exists
   * (`ON DELETE SET NULL` means a job survives its target event being removed).
   */
  supersedesJobId: string | null;
}

export interface PublicGrillRun {
  jobId: string;
  status: JobStatus;
  createdAt: string;
  restartedFromEventId: string | null;
  /**
   * The later run that rewound from this one, or null.
   *
   * **Deliberately not simply "the next run after this one".** See
   * `earlierGrillRuns` for the distinction — it is the difference between a run
   * whose work was discarded by a rewind and one that merely is not current.
   */
  supersededByJobId: string | null;
}

/**
 * The runs to offer as "earlier", newest first, with their supersession resolved.
 *
 * **"Earlier" means every `spec_grill` run except the latest.** That is the rule
 * the issue proposed and it is the right one, for a reason worth stating: a rewind
 * *dispatches a new job*, so the newest `spec_grill` row for a feature **is** that
 * feature's current grill run by construction. There is no stored "this is
 * current" flag and none is needed — position is the fact. Computing it here means
 * a client renders what the API says rather than slicing an array itself, which is
 * the browser re-implementing a rule the API owns (the same mistake as the
 * readiness predicate in #35/#89).
 *
 * Newest-first because the most recently discarded conversation is the one a user
 * who just rewound is looking for.
 *
 * **`supersededByJobId` is not just "the next run".** It is set only when a later
 * run *explicitly rewound from this one* — i.e. some job's `restarted_from_event_id`
 * names an event belonging to this job. The distinction is real and worth keeping:
 * a run replaced by ADR 012's **retry** was never rewound, nothing was truncated,
 * and calling it "superseded by" would assert a discard that did not happen. So a
 * run can be in this list with a null `supersededByJobId`, which reads correctly as
 * "an earlier run" rather than "a run something replaced".
 *
 * Input is expected oldest-first (the repository's order); the reversal is here so
 * the ordering rule lives with the selection rule instead of being a client's job.
 */
export function earlierGrillRuns(runs: FeatureGrillRun[]): PublicGrillRun[] {
  if (runs.length === 0) return [];

  // Every run except the latest. `slice` rather than a filter on a computed max,
  // because the repository's ordering is part of this function's contract and the
  // last element *is* the newest — recomputing the maximum would imply the order
  // might not hold, and two ways to answer "which is current" is how they drift.
  const earlier = runs.slice(0, -1);

  // Invert `supersedesJobId` into `supersededByJobId`. Built from *all* runs,
  // including the current one, so a rewind from an earlier run by the run that is
  // now current is still attributed — otherwise the most recent rewind, which is
  // the one a user is most likely looking for, would be the one case with no link.
  const supersededBy = new Map<string, string>();
  for (const run of runs) {
    if (run.supersedesJobId) supersededBy.set(run.supersedesJobId, run.jobId);
  }

  return earlier
    .map((run) => ({
      jobId: run.jobId,
      status: run.status,
      createdAt: run.createdAt.toISOString(),
      restartedFromEventId: run.restartedFromEventId,
      supersededByJobId: supersededBy.get(run.jobId) ?? null,
    }))
    .reverse();
}
