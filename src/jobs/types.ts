export type JobKind =
  | "spec_grill"
  | "feature_build"
  | "test_run"
  | "deploy"
  | "script_test_run"
  | "agentic_review"
  | "design_grill"
  | "rollback";
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * The job kinds that run a grill conversation — i.e. the ones with a chat surface a
 * human can answer on.
 *
 * Issue #38 needs this to answer "where does the `ask_user` tool live" with
 * something enforceable. The *prevention* is each skill's `allowed-tools`
 * frontmatter, which lists `ask_user` only for the three grill skills; this
 * constant is the API-side backstop, used to reject a question on a kind that has
 * nowhere to render it (see `jobs/internal-routes.ts`).
 *
 * `project_init` is deliberately absent from this list and still covered: it is a
 * `spec_grill` job distinguished by the feature's `feature_type`, not its kind.
 * Adding it here would name a kind that does not exist.
 */
export const GRILL_JOB_KINDS: ReadonlySet<JobKind> = new Set<JobKind>([
  "spec_grill",
  "design_grill",
]);

/**
 * How a job came to exist, as `jobs.trigger_source`'s CHECK allows it
 * (migration 049).
 *
 * **One source of truth, because there were five declarations and three of them
 * were wrong** (issue #75). `"manual"` was added to the database in 049 and to
 * three of the five TypeScript declarations; the other three still said
 * `"feature" | "schedule" | null`, so a manually-triggered run came back as a
 * value its own response type said could not occur. A client author reading the
 * declaration writes the generic fallback branch and never learns a manual run
 * is possible — which is precisely what happened to the Web app, which had to
 * widen its type by hand.
 *
 * TypeScript cannot catch that drift, because the value arrives from a `pg` row
 * typed to the narrower union: nothing forces a row type to agree with the
 * entity it maps to. Hence one constant, and `trigger-source.test.ts` asserting
 * it against the migration's own CHECK — the half TypeScript can never see.
 */
export const JOB_TRIGGER_SOURCES = ["feature", "schedule", "manual"] as const;

/**
 * The trigger source of a job, or null when the kind has none.
 *
 * `null` means "not applicable" (every `deploy`, `spec_grill` and
 * `agentic_review` row), which is a different fact from `"manual"` — "a human
 * asked". Migration 049 spells that distinction out, because collapsing them
 * would leave "why did this run happen?" unanswerable for the one run somebody
 * deliberately started.
 */
export type JobTriggerSource = (typeof JOB_TRIGGER_SOURCES)[number];

export interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  featureId: string | null;
  testId: string | null;
  testGroup: "unit" | "integration" | null;
  ref: string | null;
  /**
   * How the job came to exist. `manual` is a person pressing "Run now" on a Test
   * (issue #31) — deliberately not folded into `schedule`, which would attribute
   * a deliberate run to the scheduler in the history the field exists to explain.
   *
   * Null means the kind has no trigger source at all; see `JOB_TRIGGER_SOURCES`.
   */
  trigger: JobTriggerSource | null;
  designName: string | null;
  designSlug: string | null;
  designDescription: string | null;
  /** The `designs` row this session works on (ADR 020); null for every other kind. */
  designId: string | null;
  specContext: Record<string, unknown> | null;
  status: JobStatus;
  lastError: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /**
   * The Helm revision a `rollback` job should roll the primary release back
   * to (ADR 022). Null for every other kind. Pinned here at request time so a
   * queued rollback keeps the revision the operator chose even if newer
   * deploys land before it is claimed.
   */
  targetRevision: number | null;
  /**
   * ADR 024: the `job_events` turn this run's seed context was rewound to,
   * when the run came from a per-message "restart from here" rather than a
   * first attempt or an ADR 015 kickback. Null for every other run.
   *
   * Exists so a restarted session is identifiable from the job alone: the seed
   * itself is in `specContext`, which is deliberately never exposed publicly
   * (it can carry a whole previous ADR and transcript).
   */
  restartedFromEventId: string | null;
  /**
   * ADR 032 item 3: the earlier run whose stored Pi session this run forked from,
   * when it came from a per-message "resume from here". Null for every other run.
   *
   * The sibling of `restartedFromEventId`, and the two are **not**
   * interchangeable: that one names a `job_events` turn (ADR 024's rewind), this
   * one names a job. They record two different gestures which share a job kind and
   * a state transition but not an implementation — a rewind re-renders the earlier
   * conversation into a prompt, a fork restores the session itself.
   *
   * A column rather than only a `specContext` entry because the relationship is not
   * derivable: every spec_grill run is a newer job row, so ordering cannot
   * distinguish a fork from a retry or a rewind, and neither the transcript nor the
   * forked session file names the run it came from. See migration 057.
   */
  forkFromJobId: string | null;
}
