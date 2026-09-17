import { describe, expect, it } from "vitest";
import {
  buildGrillRestartSeed,
  canRestartFromMessage,
  isMessageRestartableStatus,
  isGrillTranscriptJob,
  isRestartableEvent,
  MAX_GRILL_CONTEXT_CHARS,
  messageRestartRefusal,
  MESSAGE_RESTART_STATUSES,
  restartBoundaryIndex,
  summarizeGrillTranscript,
  type GrillContextEvent,
} from "./grill-context.js";

function turn(
  id: string,
  type: string,
  body: { message?: string; question?: string } = {},
): GrillContextEvent {
  return {
    id,
    type,
    question: body.question ?? null,
    message: body.message ?? null,
  };
}

/** A transcript shaped like a real grill: agent asks, user answers, agent explains, submits. */
function transcript(): GrillContextEvent[] {
  return [
    turn("e1", "agent_text", { message: "Let's spec the saved-cards feature." }),
    turn("e2", "ask_user", { question: "One saved card per customer, or many?" }),
    turn("e3", "user_message", { message: "Many, with one marked default." }),
    turn("e4", "agent_text", { message: "I'll use a Stripe SetupIntent." }),
    turn("e5", "submit_adr"),
  ];
}

describe("summarizeGrillTranscript", () => {
  it("renders agent prose, agent questions and user replies as labelled turns", () => {
    expect(summarizeGrillTranscript(transcript())).toBe(
      "Agent: Let's spec the saved-cards feature.\n\n" +
        "Agent question: One saved card per customer, or many?\n\n" +
        "User: Many, with one marked default.\n\n" +
        "Agent: I'll use a Stripe SetupIntent.",
    );
  });

  it("skips events that carry no prose, so a terminal marker never appears as a turn", () => {
    const summary = summarizeGrillTranscript(transcript());
    expect(summary).not.toContain("Submitted");
    expect(summary).not.toContain("submit_adr");
  });

  it("ignores a turn whose own prose field is empty rather than emitting a bare label", () => {
    const summary = summarizeGrillTranscript([
      turn("a", "agent_text", { message: "" }),
      turn("b", "ask_user", { question: "" }),
      turn("c", "user_message", { message: "" }),
      turn("d", "agent_text", { message: "Real." }),
    ]);
    expect(summary).toBe("Agent: Real.");
  });

  it("returns an empty string for a transcript with no turns", () => {
    expect(summarizeGrillTranscript([])).toBe("");
  });

  it("keeps the most recent characters and says so when the transcript overflows the cap", () => {
    const long = "x".repeat(MAX_GRILL_CONTEXT_CHARS);
    const summary = summarizeGrillTranscript([
      turn("old", "agent_text", { message: "ANCIENT-HISTORY" }),
      turn("new", "agent_text", { message: long }),
    ]);
    expect(summary.startsWith("[Earlier grill transcript truncated]\n")).toBe(true);
    expect(summary).not.toContain("ANCIENT-HISTORY");
  });

  it("does not truncate a transcript exactly at the cap", () => {
    const exact = "y".repeat(MAX_GRILL_CONTEXT_CHARS - "Agent: ".length);
    const summary = summarizeGrillTranscript([turn("only", "agent_text", { message: exact })]);
    expect(summary.startsWith("Agent: ")).toBe(true);
    expect(summary).not.toContain("truncated");
  });
});

describe("isRestartableEvent", () => {
  it("accepts exactly the three conversation-turn types", () => {
    for (const type of ["agent_text", "ask_user", "user_message"]) {
      expect(isRestartableEvent(turn("x", type))).toBe(true);
    }
  });

  it("rejects terminal and system markers, which name no point in the conversation", () => {
    for (const type of ["submit_adr", "run_failed", "run_cancelled", "unknown_type"]) {
      expect(isRestartableEvent(turn("x", type))).toBe(false);
    }
  });
});

describe("restartBoundaryIndex", () => {
  it("finds the index of a turn in the transcript", () => {
    expect(restartBoundaryIndex(transcript(), "e3")).toBe(2);
  });

  it("returns -1 for an id that is not in this transcript", () => {
    expect(restartBoundaryIndex(transcript(), "nope")).toBe(-1);
  });

  it("returns -1 for a real event that is not a turn", () => {
    expect(restartBoundaryIndex(transcript(), "e5")).toBe(-1);
  });

  it("distinguishes the first and last turns rather than collapsing them", () => {
    const events = transcript();
    expect(restartBoundaryIndex(events, "e1")).toBe(0);
    expect(restartBoundaryIndex(events, "e4")).toBe(3);
  });
});

describe("buildGrillRestartSeed", () => {
  it("is exclusive of the chosen turn, which is the first thing to be redone", () => {
    const seed = buildGrillRestartSeed(transcript(), "e3");
    expect(seed?.grillTranscriptSummary).toBe(
      "Agent: Let's spec the saved-cards feature.\n\n" +
        "Agent question: One saved card per customer, or many?",
    );
  });

  it("preserves every turn before the boundary and nothing after it", () => {
    const summary = buildGrillRestartSeed(transcript(), "e4")?.grillTranscriptSummary ?? "";
    expect(summary).toContain("Many, with one marked default.");
    expect(summary).not.toContain("Stripe SetupIntent");
  });

  it("yields an empty transcript when the very first turn is the boundary", () => {
    const seed = buildGrillRestartSeed(transcript(), "e1");
    expect(seed).not.toBeNull();
    expect(seed?.grillTranscriptSummary).toBe("");
  });

  it("keeps everything before the last turn when restarting from the last turn", () => {
    const summary = buildGrillRestartSeed(transcript(), "e4")?.grillTranscriptSummary ?? "";
    expect(summary).toContain("One saved card per customer, or many?");
  });

  it("carries no previous ADR, because an ADR is always downstream of the boundary", () => {
    expect(buildGrillRestartSeed(transcript(), "e4")?.previousAdrMarkdown).toBe("");
  });

  it("marks the seed as a rewind so the prompt is not worded as a kickback", () => {
    expect(buildGrillRestartSeed(transcript(), "e4")?.restartFromMessage).toBe(true);
  });

  it("explains the restart in the reason field, which is what the agent is shown", () => {
    const reason = buildGrillRestartSeed(transcript(), "e4")?.kickbackReason ?? "";
    expect(reason).toContain("restarted");
    expect(reason).toContain("discarded");
  });

  it("returns null rather than a seed for an unusable boundary", () => {
    expect(buildGrillRestartSeed(transcript(), "e5")).toBeNull();
    expect(buildGrillRestartSeed(transcript(), "missing")).toBeNull();
    expect(buildGrillRestartSeed([], "e1")).toBeNull();
  });
});

describe("isGrillTranscriptJob", () => {
  it("accepts a grill and rejects every other kind, including a failed build", () => {
    expect(isGrillTranscriptJob("spec_grill")).toBe(true);
    for (const kind of ["feature_build", "test_run", "design_grill", "deploy", null]) {
      expect(isGrillTranscriptJob(kind)).toBe(false);
    }
  });
});

describe("isMessageRestartableStatus", () => {
  it("allows the states where no agreed work is in flight", () => {
    for (const status of ["draft", "spec_ready", "failed", "cancelled"]) {
      expect(isMessageRestartableStatus(status)).toBe(true);
    }
  });

  it("refuses once work is in flight or past review", () => {
    for (const status of ["queued", "running", "testing", "agentic_review", "in_review", "merged", "returned"]) {
      expect(isMessageRestartableStatus(status)).toBe(false);
    }
  });

  it("exposes exactly the set the route passes to the guarded update", () => {
    expect([...MESSAGE_RESTART_STATUSES]).toEqual(["draft", "spec_ready", "failed", "cancelled"]);
  });
});

describe("canRestartFromMessage", () => {
  const allowed = { status: "draft", latestJobKind: "spec_grill", hasActiveGrillJob: false };

  it("allows a stopped grill on a restartable feature", () => {
    expect(canRestartFromMessage(allowed)).toBe(true);
    expect(messageRestartRefusal(allowed)).toBeNull();
  });

  it("refuses a live session, which ADR 006's mid-run reply already steers", () => {
    expect(canRestartFromMessage({ ...allowed, hasActiveGrillJob: true })).toBe(false);
    expect(messageRestartRefusal({ ...allowed, hasActiveGrillJob: true })).toContain("already running");
  });

  it("refuses when the latest run is not a grill at all", () => {
    expect(canRestartFromMessage({ ...allowed, latestJobKind: "feature_build" })).toBe(false);
    expect(messageRestartRefusal({ ...allowed, latestJobKind: null })).toContain("not a grill");
  });

  it("refuses a feature that has moved past Spec", () => {
    expect(canRestartFromMessage({ ...allowed, status: "in_review" })).toBe(false);
    expect(messageRestartRefusal({ ...allowed, status: "in_review" })).toContain("in_review");
  });

  it("names the failing condition, so the route and the predicate cannot disagree", () => {
    // A feature that fails several conditions at once reports the first one the
    // predicate checks — the point is that a refusal always comes with a reason.
    const refusal = messageRestartRefusal({
      status: "merged",
      latestJobKind: "feature_build",
      hasActiveGrillJob: true,
    });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("merged");
  });
});
