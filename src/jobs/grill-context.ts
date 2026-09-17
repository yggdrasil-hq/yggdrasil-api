/**
 * How a `spec_grill` conversation becomes seed context for a *later* run.
 *
 * Two callers share this: ADR 015's kickback path (`request_action_item` hands
 * a blocked build back to a fresh interview) and ADR 024's per-message restart
 * (a user rewinds the interview to an earlier turn). Both need the same thing —
 * a bounded prose summary of an earlier transcript — so the formatting and the
 * size cap live here once rather than being spelled twice.
 *
 * Pure: no express, no pg, no config. That is deliberate — the truncation rules
 * are exactly the part worth unit-testing exhaustively, and this repo's suite
 * has no database-backed tests.
 */

/**
 * Ceiling on the summarized transcript carried in a seed. A very long
 * interview would otherwise push the whole prompt past what the model can
 * usefully attend to, and the seed competes with the repo contents the agent
 * is asked to read.
 */
export const MAX_GRILL_CONTEXT_CHARS = 12_000;

/**
 * The subset of a job event this module needs, declared structurally so a real
 * `JobEvent` satisfies it without this module depending on the repository.
 */
export interface GrillContextEvent {
  id: string;
  type: string;
  question: string | null;
  message: string | null;
}

/**
 * Renders the turns of a grill transcript as prose, keeping the most recent
 * `MAX_GRILL_CONTEXT_CHARS` characters when it would otherwise overflow.
 *
 * Keeping the *tail* is right for both callers: a kickback continues the
 * conversation, and a restart is truncated at a turn — in each case the turns
 * nearest the boundary are the ones the next run needs. Non-turn events
 * (`submit_adr`, `run_failed`, `run_cancelled`) carry no prose and are skipped;
 * `submit_adr`'s outcome is conveyed by the ADR itself, which the kickback path
 * passes separately.
 */
export function summarizeGrillTranscript(
  events: ReadonlyArray<Pick<GrillContextEvent, "type" | "question" | "message">>,
): string {
  const lines = events.flatMap((event) => {
    if (event.type === "agent_text" && event.message) {
      return [`Agent: ${event.message}`];
    }
    if (event.type === "ask_user" && event.question) {
      return [`Agent question: ${event.question}`];
    }
    if (event.type === "user_message" && event.message) {
      return [`User: ${event.message}`];
    }
    return [];
  });
  const transcript = lines.join("\n\n");
  if (transcript.length <= MAX_GRILL_CONTEXT_CHARS) {
    return transcript;
  }
  return `[Earlier grill transcript truncated]\n${transcript.slice(-MAX_GRILL_CONTEXT_CHARS)}`;
}

/**
 * ADR 024: the transcript event types a per-message restart may target — the
 * ones that render as a conversation turn and that this module can summarize.
 *
 * `submit_adr`, `run_failed`, and `run_cancelled` are system/terminal markers,
 * not turns: "restart from" one of them would not name a point in the
 * conversation, so they are rejected as boundaries rather than silently
 * accepted.
 */
export const RESTARTABLE_EVENT_TYPES = ["agent_text", "ask_user", "user_message"] as const;

/**
 * The feature states a per-message restart may start from.
 *
 * `queued`/`running`/`testing`/`agentic_review`/`in_review`/`merged` are
 * excluded because work is either in flight or already past review — rewinding
 * the interview under them would discard agreed scope behind the user's back.
 * `returned` is excluded for the same reason: ADR 015 gives it its own explicit
 * resume/kickback affordances. `failed` and `cancelled` are included, but only
 * together with the check that the feature's latest job really is the grill
 * (see `canRestartFromMessage`) — a *build* that failed also lands here, and
 * its transcript is not a grill conversation.
 */
export const MESSAGE_RESTART_STATUSES = [
  "draft",
  "spec_ready",
  "failed",
  "cancelled",
] as const;

export function isMessageRestartableStatus(status: string): boolean {
  return (MESSAGE_RESTART_STATUSES as readonly string[]).includes(status);
}

/** Whether an event can serve as a restart boundary. */
export function isRestartableEvent(event: Pick<GrillContextEvent, "type">): boolean {
  return (RESTARTABLE_EVENT_TYPES as readonly string[]).includes(event.type);
}

/**
 * Where `eventId` sits in `events`, or -1 when it is not a usable boundary —
 * absent from the transcript, or a system marker rather than a turn.
 *
 * Callers pass the events of the transcript actually on screen (the feature's
 * latest job), so an id from an *earlier* run of the same feature is rejected:
 * the turns before it in this list would not be the turns the user was reading.
 */
export function restartBoundaryIndex(
  events: ReadonlyArray<Pick<GrillContextEvent, "id" | "type">>,
  eventId: string,
): number {
  const index = events.findIndex((event) => event.id === eventId);
  if (index === -1) return -1;
  return isRestartableEvent(events[index]) ? index : -1;
}

/**
 * The seed handed to the restarted `spec_grill` job (ADR 015's `spec_context`
 * shape, reused rather than reinvented).
 *
 * A type alias rather than an interface on purpose: `jobs.spec_context` is a
 * JSONB column typed `Record<string, unknown>`, and TypeScript gives object
 * *type aliases* an implicit index signature for that assignability check but
 * not interfaces.
 *
 * `restartFromMessage` is what tells the Orchestrator to word the prompt as a
 * rewind rather than as a kickback continuation — without it the agent would
 * read "here is why implementation was blocked" over a transcript that was
 * simply rewound, which is actively misleading.
 */
export type GrillRestartSeed = {
  previousAdrMarkdown: string;
  grillTranscriptSummary: string;
  kickbackReason: string;
  restartFromMessage: true;
};

/**
 * Stated to the restarted agent in place of a kickback reason. It has to say
 * both halves: what happened (the user rewound it) and what to do about it
 * (rebuild the open questions), since the kept transcript ends mid-conversation
 * with no conclusion.
 */
export const GRILL_RESTART_REASON =
  "The user restarted this specification session from an earlier turn and asked for the " +
  "conversation from that point to be redone. Everything the previous run concluded after " +
  "that turn was discarded deliberately, so treat the kept transcript as an unfinished " +
  "discussion rather than as settled context.";

/**
 * The seed for a restart at `eventId`, or null when that event cannot be a
 * boundary.
 *
 * Boundary semantics — deliberately *exclusive*: the context is the turns
 * strictly **before** the chosen one, and the chosen turn is the first thing
 * redone. "Restart from here" on the agent's question at turn N therefore
 * re-asks that question; including it would hand the agent its own question
 * already answered by whatever followed.
 *
 * `previousAdrMarkdown` is empty on purpose. An ADR is the *last* thing a grill
 * produces, so in a rewind it is always downstream of the boundary and is
 * discarded with the rest of the tail — which is also why the UI requires an
 * explicit confirmation before rewinding a feature whose ADR was already
 * approved.
 */
export function buildGrillRestartSeed(
  events: ReadonlyArray<GrillContextEvent>,
  eventId: string,
): GrillRestartSeed | null {
  const index = restartBoundaryIndex(events, eventId);
  if (index === -1) return null;
  return {
    previousAdrMarkdown: "",
    grillTranscriptSummary: summarizeGrillTranscript(events.slice(0, index)),
    kickbackReason: GRILL_RESTART_REASON,
    restartFromMessage: true,
  };
}

/**
 * Whether a feature's latest job is a grill — i.e. the transcript on screen is
 * a grill conversation at all. A failed `feature_build` also leaves a feature
 * `failed`, and its events are not restartable turns.
 */
export function isGrillTranscriptJob(kind: string | null): boolean {
  return kind === "spec_grill";
}

/**
 * The single gate both the route and the Web app apply.
 *
 * `hasActiveGrillJob` blocks rewinding a *live* session: ADR 006's mid-run
 * reply is the mechanism for steering a run in progress, and rewinding
 * underneath it would race the agent that is still writing to the transcript.
 */
export function canRestartFromMessage(input: {
  status: string;
  latestJobKind: string | null;
  hasActiveGrillJob: boolean;
}): boolean {
  return messageRestartRefusal(input) === null;
}

/**
 * Why a restart was refused, in the words the API hands back to the Web app —
 * or null when it is allowed.
 *
 * Deliberately the implementation *behind* `canRestartFromMessage` rather than
 * a second set of conditions beside it: two copies of this logic would
 * eventually disagree about which condition failed, and the user would be told
 * the wrong reason.
 */
export function messageRestartRefusal(input: {
  status: string;
  latestJobKind: string | null;
  hasActiveGrillJob: boolean;
}): string | null {
  if (!isMessageRestartableStatus(input.status)) {
    return (
      `A grill can only be rewound while the feature is still in Spec, or in a stopped ` +
      `state — this one is ${input.status}.`
    );
  }
  if (!isGrillTranscriptJob(input.latestJobKind)) {
    return "This feature's most recent run is not a grill session.";
  }
  if (input.hasActiveGrillJob) {
    return "A grill session is already running for this feature.";
  }
  return null;
}
