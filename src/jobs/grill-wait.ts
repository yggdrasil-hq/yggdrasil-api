/**
 * How long a grill has been waiting on an unanswered question (issue #92).
 *
 * **The gap this closes.** `features.awaiting_user_input` is a boolean: it records
 * *that* a grill is paused on a human, not *since when*. So no surface can tell a
 * question asked twenty seconds ago from one asked twenty-three hours ago, and
 * the second is the case worth acting on — especially since #82 gave one
 * unanswered question a bound, after which the run is *failed*. Without an age,
 * that failure arrives with no warning at all: the operator learns the grill was
 * abandoned by being told it died.
 *
 * **Derived, not stored.** The issue offers a timestamp column or "a derived read
 * from the most recent `ask_user` event's `created_at` with no later
 * `user_message`", and notes the second needs no migration. It is the better
 * answer for more than that: a stored column is a second record of a fact the
 * event stream already holds, so the two can disagree — and the failure mode is a
 * *wrong* age rather than a missing one, which is worse than the problem being
 * fixed. `awaiting_user_input` and this derivation are reconciled on read, with a
 * disagreement reported as "no age" rather than as a guess.
 *
 * **Pure, with a structural event type.** `grill-context.ts` set this precedent:
 * the module declares the two fields it needs, so a real `JobEvent` satisfies it
 * without this depending on the repository or on a database.
 */

/**
 * The subset of a job event this derivation needs.
 *
 * Nothing about the question's *content* — only that it was asked, when, and
 * whether a reply followed. #38's structured form and #59's verdict are the
 * route's business, not this one's.
 */
export interface GrillWaitEvent {
  type: string;
  createdAt: Date;
}

/**
 * Issue #92: an open grill question, as the API reports it to a client.
 *
 * **Null and "not waiting" are the same thing**, deliberately: the field is
 * present exactly when a human owes an answer. A shape with nullable members
 * inside it would make "no wait" and "a wait with unknown fields" the same
 * object, which is the collapse #73 spent an issue undoing for `findings`.
 */
export interface AwaitingReply {
  /** When the unanswered question was asked (ISO). The fact; the age is arithmetic. */
  since: string;
  /**
   * The bound on one unanswered question, in milliseconds.
   *
   * This is the API's *view* of a value the Orchestrator owns — see
   * `config.grills.replyTimeoutMs` for why it is a mirror rather than something
   * this service can read, and for how the two are kept honest.
   */
  timeoutMs: number;
  /**
   * Whether `timeoutMs` was configured on this service or is its shipped default.
   *
   * Exposed because it is the one thing that can make a countdown *lie*: the
   * Orchestrator reads its own `GRILL_REPLY_TIMEOUT` from its own `.env`, so an
   * operator who raised the bound there and not here has an API asserting 24h
   * over a run that will actually wait longer. `"default"` is a client's signal
   * that the number is an assumption rather than a statement of configuration,
   * and a client that renders a countdown can hedge or omit it accordingly.
   *
   * The API cannot detect the disagreement itself — it cannot see the other
   * service's environment — so this field is the honest half it can offer.
   */
  timeoutSource: "configured" | "default";
}

/**
 * The unanswered question in a job's event stream, or null when there is none.
 *
 * Compares the most recent `ask_user` against the most recent `user_message`
 * rather than walking the tail backwards, so the tie is an explicit decision
 * instead of an artefact of array order.
 *
 * **A tie counts as answered.** Postgres' `created_at` defaults to `NOW()`, which
 * is the *transaction start* time, and `listByJob` orders by `created_at` alone —
 * so two events written in the same microsecond have no defined relative order.
 * That needs two HTTP requests to start within a microsecond of each other, so it
 * is rare rather than impossible; when it happens, "answered" is the safe reading,
 * because the alternative is reporting the age of a question that has already
 * been replied to — an age that only grows, and so would drift toward the
 * countdown's deadline while the grill is in fact moving on. Reporting no age is
 * indistinguishable to a reader from "waiting, age unknown", which is honest.
 *
 * The opposite error (no age for a genuinely open question) costs a missing
 * affordance for one poll interval; this one would put a rising wrong number
 * under a countdown. Ties resolve toward the cheaper mistake.
 */
export function deriveUnansweredQuestion(
  events: GrillWaitEvent[],
): { since: Date } | null {
  let latestQuestion: Date | null = null;
  let latestReply: Date | null = null;

  for (const event of events) {
    if (event.type === "ask_user") latestQuestion = event.createdAt;
    if (event.type === "user_message") latestReply = event.createdAt;
  }

  if (!latestQuestion) return null;
  if (latestReply && latestReply.getTime() >= latestQuestion.getTime()) return null;
  return { since: latestQuestion };
}

/**
 * The wire shape the feature-events read carries, or null when nobody is being
 * waited on.
 *
 * **Gated on `awaitingUserInput` *and* on the events.** Both are needed, and the
 * gate is deliberately an AND rather than either alone:
 *
 * - the flag is what every other surface already uses to decide whether a reply
 *   is possible (`canReplyToGrill`), so reporting an age for a feature the UI
 *   will not offer a reply box for would describe a wait the user cannot act on;
 * - the events are the only record of *when*, so a flag with no matching
 *   `ask_user` — one set by an earlier job, or cleared-then-restored by a
 *   transition this read raced — must report **no age** rather than an invented
 *   one.
 *
 * The second case is the reason this cannot simply trust the flag. Both are
 * best-effort writes made after the event row is committed
 * (`syncFeatureState`), so a read can legitimately land between the two, and
 * "waiting, age unknown" is the truthful description of that instant.
 *
 * **Restart and replay need no special handling, and that is a property of the
 * data rather than of this function.** ADR 024's restart dispatches a *new* job
 * with the rewound transcript as seed context, and the route reads the latest
 * job's own events (`listByJob`), so a restarted grill has no `ask_user` of its
 * own until it asks one — reported as no age, which is correct. A running clock
 * carried across a restart is the bug this avoids without trying: there is no
 * shared state to carry it. Every transition that clears the flag (`resetForRetry`,
 * `restartFromCancelled`, `cancel`, `setSpecReady`, `run_failed`/`run_cancelled`)
 * clears it on the same row the read gates on, so a stale age cannot outlive the
 * wait either.
 */
export function deriveAwaitingReply(input: {
  awaitingUserInput: boolean;
  events: GrillWaitEvent[];
  timeoutMs: number;
  timeoutSource: "configured" | "default";
}): AwaitingReply | null {
  if (!input.awaitingUserInput) return null;

  const open = deriveUnansweredQuestion(input.events);
  if (!open) return null;

  return {
    since: open.since.toISOString(),
    timeoutMs: input.timeoutMs,
    timeoutSource: input.timeoutSource,
  };
}
