import { describe, expect, it } from "vitest";
import {
  LIVE_PROTOCOL_VERSION,
  LIVE_DELTA_MAX_PAYLOAD_BYTES,
  deltaFromPayload,
  encodeDeltaPayload,
  liveTopicForFeature,
  parseClientFrame,
  toLiveJobEvent,
} from "./types.js";
import type { JobEvent } from "../jobs/events-repository.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const FEATURE_ID = "22222222-2222-4222-8222-222222222222";

describe("parseClientFrame", () => {
  it("parses a subscribe frame with both ids", () => {
    const frame = parseClientFrame(
      JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID }),
    );
    expect(frame).toEqual({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID });
  });

  it("parses unsubscribe and ping", () => {
    expect(parseClientFrame(JSON.stringify({ type: "unsubscribe", featureId: FEATURE_ID }))).toEqual(
      { type: "unsubscribe", featureId: FEATURE_ID },
    );
    expect(parseClientFrame(JSON.stringify({ type: "ping" }))).toEqual({ type: "ping" });
  });

  it("rejects a subscribe frame whose ids are not uuids", () => {
    // The boundary check: an id that is not a uuid can never name a real row, so
    // it is refused before any lookup rather than becoming a wasted query.
    expect(
      parseClientFrame(
        JSON.stringify({ type: "subscribe", projectId: "not-a-uuid", featureId: FEATURE_ID }),
      ),
    ).toBeNull();
    expect(
      parseClientFrame(
        JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, featureId: 42 }),
      ),
    ).toBeNull();
    expect(
      parseClientFrame(JSON.stringify({ type: "subscribe", projectId: PROJECT_ID })),
    ).toBeNull();
  });

  it("rejects malformed, non-object, and unknown frames", () => {
    expect(parseClientFrame("{not json")).toBeNull();
    expect(parseClientFrame("null")).toBeNull();
    expect(parseClientFrame('"a string"')).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "drop_tables" }))).toBeNull();
    expect(parseClientFrame(JSON.stringify({}))).toBeNull();
  });

  it("does not treat the parsed ids as proof of access", () => {
    // A well-formed frame for a project the caller cannot see parses fine —
    // authorisation is a separate, mandatory step. This test exists so the
    // distinction is not lost in a later refactor.
    const frame = parseClientFrame(
      JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID }),
    );
    expect(frame).not.toBeNull();
  });
});

describe("liveTopicForFeature", () => {
  it("namespaces by feature so a future topic shape cannot collide", () => {
    expect(liveTopicForFeature(FEATURE_ID)).toBe(`feature:${FEATURE_ID}`);
  });
});

describe("toLiveJobEvent", () => {
  it("converts the stored Date into an ISO string for the wire", () => {
    const createdAt = new Date("2026-09-18T10:00:00.000Z");
    const event: JobEvent = {
      id: "event_1",
      jobId: "job_1",
      type: "ask_user",
      question: "Which database?",
      markdown: null,
      message: null,
      status: null,
      prUrl: null,
      summary: null,
      verdict: null,
      questionForm: null,
      actionItems: null,
      snapshot: null,
      createdAt,
    };

    const live = toLiveJobEvent(event);
    expect(live.createdAt).toBe("2026-09-18T10:00:00.000Z");
    expect(live).toMatchObject({
      id: "event_1",
      jobId: "job_1",
      type: "ask_user",
      question: "Which database?",
    });
  });

  it("keeps nulls as nulls rather than dropping the keys", () => {
    // The Web app's rendering predicates read these fields directly, and a
    // missing key would be indistinguishable from an error while an explicit
    // null is the shape the REST read already returns.
    const live = toLiveJobEvent({
      id: "event_2",
      jobId: "job_2",
      type: "agent_text",
      question: null,
      markdown: null,
      message: "hello",
      status: null,
      prUrl: null,
      summary: null,
      verdict: null,
      questionForm: null,
      actionItems: null,
      snapshot: null,
      createdAt: new Date("2026-09-18T10:00:00.000Z"),
    });
    expect(live.question).toBeNull();
    expect(live.snapshot).toBeNull();
    expect(live.actionItems).toBeNull();
  });
});

describe("LIVE_PROTOCOL_VERSION", () => {
  it("is a positive integer, so a client can compare rather than guess", () => {
    expect(Number.isInteger(LIVE_PROTOCOL_VERSION)).toBe(true);
    expect(LIVE_PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

describe("delta payload contract", () => {
  const delta = { featureId: FEATURE_ID, jobId: "job_1", text: "Hello " };

  it("round-trips a delta from the writer to the frame the client receives", () => {
    // The two halves of the delta contract: the API's NOTIFY payload and the
    // relay's parse of it. Pinned together because they are written in different
    // modules but must agree exactly, and a mismatch would silently drop every
    // delta rather than fail loudly.
    const payload = encodeDeltaPayload(delta);
    expect(payload).not.toBeNull();

    expect(deltaFromPayload(payload!)).toEqual({
      topic: `feature:${FEATURE_ID}`,
      frame: {
        type: "job_event_delta",
        featureId: FEATURE_ID,
        jobId: "job_1",
        // Verbatim, whitespace included: the client concatenates these, so a
        // trimmed chunk would corrupt the streamed text.
        text: "Hello ",
      },
    });
  });

  it("refuses to encode an empty text, feature id, or job id", () => {
    expect(encodeDeltaPayload({ ...delta, text: "" })).toBeNull();
    expect(encodeDeltaPayload({ ...delta, featureId: "" })).toBeNull();
    expect(encodeDeltaPayload({ ...delta, jobId: "" })).toBeNull();
  });

  it("refuses an oversize payload, measured in bytes", () => {
    // pg_notify's hard limit is 8000 bytes. A multi-byte character costs more
    // than one, so the guard has to count bytes rather than characters — this
    // string is under the limit by length and over it by bytes.
    const multibyte = "\u00e9".repeat(4_000);
    expect(multibyte.length).toBeLessThan(LIVE_DELTA_MAX_PAYLOAD_BYTES);
    expect(encodeDeltaPayload({ ...delta, text: multibyte })).toBeNull();
  });

  it("parses a payload with extra fields rather than rejecting it", () => {
    // Forward compatibility: a later producer adding a field should not break
    // the relay's parse.
    const parsed = deltaFromPayload(
      JSON.stringify({ ...delta, somethingNew: true }),
    );
    expect(parsed?.frame).toMatchObject({ type: "job_event_delta" });
  });

  it("returns null for malformed or incomplete payloads", () => {
    expect(deltaFromPayload("not json")).toBeNull();
    expect(deltaFromPayload("null")).toBeNull();
    expect(deltaFromPayload('"a string"')).toBeNull();
    expect(deltaFromPayload(JSON.stringify({ featureId: FEATURE_ID, jobId: "job_1" }))).toBeNull();
    expect(deltaFromPayload(JSON.stringify({ ...delta, text: "" }))).toBeNull();
    expect(deltaFromPayload(JSON.stringify({ ...delta, featureId: 7 }))).toBeNull();
  });

  it("routes the delta to the feature topic, not the job", () => {
    // Subscription is by feature (ADR 019 item 9), so a delta for a later job of
    // the same feature must reach the same subscribers.
    const parsed = deltaFromPayload(JSON.stringify({ ...delta, jobId: "job_2" }));
    expect(parsed?.topic).toBe(`feature:${FEATURE_ID}`);
    expect(parsed?.frame).toMatchObject({ jobId: "job_2" });
  });
});
