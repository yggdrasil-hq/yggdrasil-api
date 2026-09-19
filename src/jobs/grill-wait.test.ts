import { describe, expect, it } from "vitest";
import {
  deriveAwaitingReply,
  deriveUnansweredQuestion,
  type GrillWaitEvent,
} from "./grill-wait.js";

/**
 * Issue #92. These are the correctness rules, so they are asserted per case
 * rather than through one happy path: the derivation decides *whether a human
 * owes an answer and since when*, and both halves of that can be wrong in ways
 * nobody would notice from the UI.
 */

/** Minimal event factory — only the two fields the derivation reads. */
function event(type: string, at: string): GrillWaitEvent {
  return { type, createdAt: new Date(at) };
}

describe("deriveUnansweredQuestion", () => {
  it("returns the last question when nothing answered it", () => {
    const events = [
      event("agent_text", "2026-01-01T10:00:00Z"),
      event("ask_user", "2026-01-01T10:05:00Z"),
    ];

    expect(deriveUnansweredQuestion(events)?.since.toISOString()).toBe(
      "2026-01-01T10:05:00.000Z",
    );
  });

  it("returns the *latest* question in a multi-question interview", () => {
    // The age of the wait is the age of the open question, not of the first one
    // — an interview that asked four questions over an hour and is now on the
    // fifth has been waiting minutes, not an hour.
    const events = [
      event("ask_user", "2026-01-01T10:00:00Z"),
      event("user_message", "2026-01-01T10:02:00Z"),
      event("ask_user", "2026-01-01T10:10:00Z"),
      event("user_message", "2026-01-01T10:11:00Z"),
      event("ask_user", "2026-01-01T10:30:00Z"),
    ];

    expect(deriveUnansweredQuestion(events)?.since.toISOString()).toBe(
      "2026-01-01T10:30:00.000Z",
    );
  });

  it("returns null once the question was answered", () => {
    const events = [
      event("ask_user", "2026-01-01T10:00:00Z"),
      event("user_message", "2026-01-01T10:01:00Z"),
    ];

    expect(deriveUnansweredQuestion(events)).toBeNull();
  });

  it("returns null for a stream with no question at all", () => {
    expect(deriveUnansweredQuestion([event("agent_text", "2026-01-01T10:00:00Z")])).toBeNull();
    expect(deriveUnansweredQuestion([])).toBeNull();
  });

  it("treats a same-timestamp question and reply as answered", () => {
    /*
     * The tie. `created_at` is the transaction start time and `listByJob` orders
     * by it alone, so two events in the same microsecond have no defined order.
     * Resolving toward "answered" is the safe direction: the alternative reports
     * a rising age for a question already replied to, which under a countdown is a
     * wrong number, whereas no age reads as "waiting, age unknown" and is honest.
     *
     * Asserted in both array orders, because array order is exactly what is
     * undefined in this case — a version relying on it would pass one and fail
     * the other.
     */
    const question = event("ask_user", "2026-01-01T10:00:00.000Z");
    const reply = event("user_message", "2026-01-01T10:00:00.000Z");

    expect(deriveUnansweredQuestion([question, reply])).toBeNull();
    expect(deriveUnansweredQuestion([reply, question])).toBeNull();
  });

  it("still reports a question asked after the last reply", () => {
    // The other side of the tie rule: strictly-later is not a tie, and must not
    // be swallowed by it.
    const events = [
      event("ask_user", "2026-01-01T10:00:00.000Z"),
      event("user_message", "2026-01-01T10:00:00.000Z"),
      event("ask_user", "2026-01-01T10:00:01.000Z"),
    ];

    expect(deriveUnansweredQuestion(events)?.since.toISOString()).toBe(
      "2026-01-01T10:00:01.000Z",
    );
  });

  it("ignores prose between a question and its reply", () => {
    // `agent_text` and streaming deltas are frequent; only a `user_message`
    // answers a question, so a busy stream must not hide the open one.
    const events = [
      event("ask_user", "2026-01-01T10:00:00Z"),
      event("agent_text_delta", "2026-01-01T10:00:01Z"),
      event("agent_text", "2026-01-01T10:00:02Z"),
      event("report_test_step", "2026-01-01T10:00:03Z"),
    ];

    expect(deriveUnansweredQuestion(events)?.since.toISOString()).toBe(
      "2026-01-01T10:00:00.000Z",
    );
  });
});

const TIMEOUT_MS = 24 * 60 * 60 * 1000;

describe("deriveAwaitingReply", () => {
  const openEvent = [event("ask_user", "2026-01-01T10:00:00Z")];

  it("reports the question's timestamp and the bound", () => {
    expect(
      deriveAwaitingReply({
        awaitingUserInput: true,
        events: openEvent,
        timeoutMs: TIMEOUT_MS,
        timeoutSource: "default",
      }),
    ).toEqual({
      since: "2026-01-01T10:00:00.000Z",
      timeoutMs: TIMEOUT_MS,
      timeoutSource: "default",
    });
  });

  it("passes the bound's provenance through unchanged", () => {
    // The client's only defence against a countdown that disagrees with the
    // Orchestrator's real bound, so it must not be flattened to a constant.
    const reply = deriveAwaitingReply({
      awaitingUserInput: true,
      events: openEvent,
      timeoutMs: 3_600_000,
      timeoutSource: "configured",
    });

    expect(reply?.timeoutMs).toBe(3_600_000);
    expect(reply?.timeoutSource).toBe("configured");
  });

  it("reports nothing when the feature is not awaiting input", () => {
    // The gate the rest of the app uses. Reporting an age here would describe a
    // wait the UI deliberately offers no reply box for.
    expect(
      deriveAwaitingReply({
        awaitingUserInput: false,
        events: openEvent,
        timeoutMs: TIMEOUT_MS,
        timeoutSource: "default",
      }),
    ).toBeNull();
  });

  it("reports nothing when the flag is set but no question is open", () => {
    /*
     * The defensive case, and the reason this cannot simply trust the flag.
     * `awaiting_user_input` and the `ask_user` row are two best-effort writes
     * (`syncFeatureState` runs after the event commits), so a read can land
     * between them. "Waiting, age unknown" is then the truth, and inventing an
     * age from an unrelated earlier event — or from the job's start — would be
     * worse than showing none: it would put a wrong number under a countdown.
     */
    expect(
      deriveAwaitingReply({
        awaitingUserInput: true,
        events: [event("agent_text", "2026-01-01T10:00:00Z")],
        timeoutMs: TIMEOUT_MS,
        timeoutSource: "default",
      }),
    ).toBeNull();
  });

  it("reports nothing when the flag is set but the question was answered", () => {
    // The same disagreement from the other side: the reply landed (and cleared
    // the flag in the same request) but this read saw the pre-clear row.
    expect(
      deriveAwaitingReply({
        awaitingUserInput: true,
        events: [
          event("ask_user", "2026-01-01T10:00:00Z"),
          event("user_message", "2026-01-01T10:01:00Z"),
        ],
        timeoutMs: TIMEOUT_MS,
        timeoutSource: "default",
      }),
    ).toBeNull();
  });

  it("reports nothing for a restarted grill that has not asked yet (ADR 024)", () => {
    /*
     * A restart dispatches a *new* job whose transcript is seed context, so its
     * own event list holds no `ask_user` until it asks one. That is why replay
     * needs no special handling — there is no clock to carry across, because the
     * route reads the latest job's own events. If this ever regressed to reading
     * across jobs, an old question's timestamp would appear here as a
     * freshly-started run's age.
     */
    expect(
      deriveAwaitingReply({
        awaitingUserInput: false,
        events: [event("agent_text", "2026-01-01T10:00:00Z")],
        timeoutMs: TIMEOUT_MS,
        timeoutSource: "default",
      }),
    ).toBeNull();
  });
});
