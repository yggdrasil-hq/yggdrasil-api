import { describe, expect, it } from "vitest";
import {
  LIVE_PROTOCOL_VERSION,
  LIVE_DELTA_MAX_PAYLOAD_BYTES,
  LIVE_SCOPE_KINDS,
  deltaFromPayload,
  encodeDeltaPayload,
  isLiveScopeKind,
  liveScopeForJob,
  liveScopesForJob,
  liveTopicForScope,
  parseClientFrame,
  parseLiveScope,
  scopesEqual,
  toLiveJobEvent,
  type LiveScope,
} from "./types.js";
import type { JobEvent } from "../jobs/events-repository.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "88888888-8888-4888-8888-888888888888";
const FEATURE_ID = "22222222-2222-4222-8222-222222222222";
const TEST_ID = "99999999-9999-4999-8999-999999999999";
const JOB_ID = "55555555-5555-4555-8555-555555555555";

const featureScope: LiveScope = { kind: "feature", id: FEATURE_ID };
const designScope: LiveScope = { kind: "design_session", id: SESSION_ID };
const testScope: LiveScope = { kind: "test", id: TEST_ID };

describe("LiveScope", () => {
  it("is a closed union, and the runtime check enforces it", () => {
    // The whole safety property of ADR 033 §2 rests on this being closed: the
    // registries are keyed by it, so a kind the code does not understand has to be
    // *unrepresentable* rather than merely unexpected. A `job` scope is the
    // specific shape that was considered for #90 and rejected.
    for (const kind of LIVE_SCOPE_KINDS) expect(isLiveScopeKind(kind)).toBe(true);
    for (const other of ["job", "Feature", "", "feature ", 7, null, undefined, {}]) {
      expect(isLiveScopeKind(other)).toBe(false);
    }
  });

  it("parses a scope, requiring a known kind and a uuid id", () => {
    expect(parseLiveScope(featureScope)).toEqual(featureScope);
    expect(parseLiveScope(designScope)).toEqual(designScope);
    expect(parseLiveScope(testScope)).toEqual(testScope);
  });

  it("refuses an unknown kind rather than passing it through", () => {
    // Not a cosmetic rejection: the authoriser registry is indexed by kind, so
    // passing an unknown one through would either widen access or throw inside an
    // authorisation path. A frame the server cannot interpret is a protocol error
    // the client can act on.
    expect(parseLiveScope({ kind: "job", id: FEATURE_ID })).toBeNull();
    expect(parseLiveScope({ kind: "feature" })).toBeNull();
    expect(parseLiveScope({ id: FEATURE_ID })).toBeNull();
    expect(parseLiveScope(null)).toBeNull();
    expect(parseLiveScope("feature")).toBeNull();
  });

  it("refuses a non-uuid id, so no authoriser queries with a value Postgres rejects", () => {
    expect(parseLiveScope({ kind: "feature", id: "not-a-uuid" })).toBeNull();
    expect(parseLiveScope({ kind: "feature", id: 42 })).toBeNull();
    expect(parseLiveScope({ kind: "design_session", id: "" })).toBeNull();
  });

  it("compares by both kind and id", () => {
    // The id alone is not enough: the same uuid is a feature id in one scope and
    // a job id in another, and comparing only ids is exactly the confusion the
    // tagged scope exists to prevent.
    expect(scopesEqual(featureScope, { kind: "feature", id: FEATURE_ID })).toBe(true);
    expect(scopesEqual(featureScope, { kind: "feature", id: TEST_ID })).toBe(false);
    expect(scopesEqual(featureScope, { kind: "test", id: FEATURE_ID })).toBe(false);
  });
});

describe("liveTopicForScope", () => {
  it("namespaces each kind, so two scopes cannot collide", () => {
    // The hub treats a topic as an opaque string, so the prefixes are the only
    // thing keeping a feature id from colliding with a test id — and the ids are
    // all uuids from the same source, so this is the property that matters.
    expect(liveTopicForScope(featureScope)).toBe(`feature:${FEATURE_ID}`);
    expect(liveTopicForScope(designScope)).toBe(`design:${SESSION_ID}`);
    expect(liveTopicForScope(testScope)).toBe(`test:${TEST_ID}`);

    const topics = new Set([
      liveTopicForScope(featureScope),
      liveTopicForScope(designScope),
      liveTopicForScope(testScope),
    ]);
    expect(topics.size).toBe(3);
  });

  it("keeps the topic prefix issue #25 shipped for design sessions", () => {
    // A topic is a cross-process contract — the API's listener, the hub and the
    // page all agree on the string — so `design_session`'s topic stays `design:`.
    // Asserted rather than assumed because the kind's *name* and its prefix differ,
    // which is the kind of mismatch a later tidy-up would "fix".
    expect(liveTopicForScope({ kind: "design_session", id: SESSION_ID })).toBe(`design:${SESSION_ID}`);
    expect(liveTopicForScope({ kind: "design_session", id: SESSION_ID })).not.toContain("design_session");
  });

  it("gives every kind a distinct topic for one id", () => {
    const topics = LIVE_SCOPE_KINDS.map((kind) => liveTopicForScope({ kind, id: FEATURE_ID }));
    expect(new Set(topics).size).toBe(LIVE_SCOPE_KINDS.length);
  });
});

describe("liveScopesForJob (issue #100)", () => {
  it("gives a feature-driven test_run both of its surfaces, feature first", () => {
    // The whole of issue #100. One job, two pages: the feature's Testing stage and
    // the Test entity's run history. Before this the feature won outright and the
    // second page got no signal at all.
    expect(
      liveScopesForJob({
        jobId: JOB_ID,
        featureId: FEATURE_ID,
        jobKind: "test_run",
        testId: TEST_ID,
      }),
    ).toEqual([
      { kind: "feature", id: FEATURE_ID },
      { kind: "test", id: TEST_ID },
    ]);
  });

  it("keeps the feature topic first, so a single-scope path is unchanged", () => {
    // Ordering is the contract: `liveScopeForJob` is the first element, so the
    // delta path and anything else that can carry one scope keeps the routing it
    // has always had. Asserted as a *pair* of the two functions so they cannot
    // drift apart.
    const job = {
      jobId: JOB_ID,
      featureId: FEATURE_ID,
      jobKind: "test_run" as const,
      testId: TEST_ID,
    };
    expect(liveScopesForJob(job)[0]).toEqual(liveScopeForJob(job));
  });

  it("does not widen a job that has only one scope", () => {
    // The direction that matters in the other way: this is a fan-out, not a
    // broadcast. A feature's job must not acquire a test topic it has no test id
    // for, and a scheduled run must not acquire a feature topic it has no feature
    // for — either would deliver a project's events to a page that never asked for
    // them.
    expect(
      liveScopesForJob({
        jobId: JOB_ID,
        featureId: FEATURE_ID,
        jobKind: "spec_grill",
        testId: null,
      }),
    ).toEqual([{ kind: "feature", id: FEATURE_ID }]);

    expect(
      liveScopesForJob({
        jobId: JOB_ID,
        featureId: null,
        jobKind: "test_run",
        testId: TEST_ID,
      }),
    ).toEqual([{ kind: "test", id: TEST_ID }]);
  });

  it("keeps the design session's single topic, keyed by the job id", () => {
    expect(
      liveScopesForJob({
        jobId: JOB_ID,
        featureId: null,
        jobKind: "design_grill",
        testId: null,
      }),
    ).toEqual([{ kind: "design_session", id: JOB_ID }]);
  });

  it("does not give a job with a feature a design topic as well", () => {
    // Refused rather than fanned out: a design session's scope id is the *job*
    // id, so a `design_grill` that somehow carried a feature would be handed
    // `design:<jobId>` for a design session that does not exist. Version 1 was
    // unreachable there too (it tested the feature and returned), so this is the
    // same reading made explicit — and it is the one place the plural could
    // otherwise fabricate a second destination.
    expect(
      liveScopesForJob({
        jobId: JOB_ID,
        featureId: FEATURE_ID,
        jobKind: "design_grill",
        testId: null,
      }),
    ).toEqual([{ kind: "feature", id: FEATURE_ID }]);
  });

  it("returns an empty list for a job nothing reads", () => {
    // The array's null: dropping is honest, because inventing a topic nobody reads
    // would be noise pretending to be a signal.
    expect(
      liveScopesForJob({
        jobId: JOB_ID,
        featureId: null,
        jobKind: "deploy",
        testId: null,
      }),
    ).toEqual([]);
  });
});

describe("liveScopeForJob", () => {
  it("routes a feature's job to the feature scope", () => {
    expect(
      liveScopeForJob({ jobId: JOB_ID, featureId: FEATURE_ID, jobKind: "spec_grill", testId: null }),
    ).toEqual({ kind: "feature", id: FEATURE_ID });
  });

  it("routes a feature-less design_grill to its session scope, keyed by the JOB id", () => {
    // The one scope whose id is a job id: a design session **is** a `design_grill`
    // job (ADR 014), and that is how the REST route resolves its `:sessionId`.
    expect(
      liveScopeForJob({ jobId: JOB_ID, featureId: null, jobKind: "design_grill", testId: null }),
    ).toEqual({ kind: "design_session", id: JOB_ID });
  });

  it("routes a scheduled test_run to the test scope", () => {
    expect(
      liveScopeForJob({ jobId: JOB_ID, featureId: null, jobKind: "test_run", testId: TEST_ID }),
    ).toEqual({ kind: "test", id: TEST_ID });
  });

  it("keeps a feature-driven test_run on the feature scope as its primary", () => {
    // One job, two surfaces: a feature-driven `test_run` carries both ids, and the
    // primary is feature so the single-scope routing it has always had does not
    // change. The second delivery to the Test entity's page is
    // `liveScopesForJob`'s, above (issue #100).
    expect(
      liveScopeForJob({ jobId: JOB_ID, featureId: FEATURE_ID, jobKind: "test_run", testId: TEST_ID }),
    ).toEqual({ kind: "feature", id: FEATURE_ID });
  });

  it("does not key the design branch on the id alone", () => {
    // The asymmetry worth pinning: `feature` and `test` scopes are recognised by
    // the id's *presence*, but a design session's id is a job id, which says
    // nothing about what it is. So a job with a job id and nothing else must be
    // dropped rather than guessed onto `design:`.
    expect(liveScopeForJob({ jobId: JOB_ID, featureId: null, jobKind: "deploy", testId: null })).toBeNull();
    expect(liveScopeForJob({ jobId: JOB_ID, featureId: null, jobKind: "feature_build", testId: null })).toBeNull();
  });

  it("returns null for a job nothing reads, rather than inventing a topic", () => {
    // A topic nobody subscribes to is noise pretending to be a signal.
    expect(liveScopeForJob({ jobId: JOB_ID, featureId: null, jobKind: "agentic_review", testId: null })).toBeNull();
  });
});

describe("parseClientFrame (ADR 033 §1)", () => {
  it("parses a subscribe frame with a project and a scope", () => {
    const frame = parseClientFrame(
      JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, scope: featureScope }),
    );
    expect(frame).toEqual({ type: "subscribe", projectId: PROJECT_ID, scope: featureScope });
  });

  it("parses every scope kind through the same frame", () => {
    // The point of §1: three scopes, one frame shape. Version 1 needed three frame
    // names for this (plus three `unsubscribe` ones).
    for (const scope of [featureScope, designScope, testScope]) {
      expect(
        parseClientFrame(JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, scope })),
      ).toEqual({ type: "subscribe", projectId: PROJECT_ID, scope });
    }
  });

  it("parses unsubscribe and ping", () => {
    expect(parseClientFrame(JSON.stringify({ type: "unsubscribe", scope: designScope }))).toEqual({
      type: "unsubscribe",
      scope: designScope,
    });
    expect(parseClientFrame(JSON.stringify({ type: "ping" }))).toEqual({ type: "ping" });
  });

  it("rejects a subscribe frame whose ids are not uuids", () => {
    // The boundary check: an id that is not a uuid can never name a real row, so
    // it is refused before any lookup rather than becoming a wasted query.
    expect(
      parseClientFrame(
        JSON.stringify({ type: "subscribe", projectId: "not-a-uuid", scope: featureScope }),
      ),
    ).toBeNull();
    expect(
      parseClientFrame(
        JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, scope: { kind: "feature", id: 42 } }),
      ),
    ).toBeNull();
    expect(parseClientFrame(JSON.stringify({ type: "subscribe", projectId: PROJECT_ID }))).toBeNull();
  });

  it("refuses a scope with an unknown kind, rather than subscribing to something else", () => {
    expect(
      parseClientFrame(
        JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, scope: { kind: "job", id: JOB_ID } }),
      ),
    ).toBeNull();
    expect(
      parseClientFrame(JSON.stringify({ type: "unsubscribe", scope: { kind: "job", id: JOB_ID } })),
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
      JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, scope: featureScope }),
    );
    expect(frame).not.toBeNull();
  });

  it("refuses version 1's frames, which is what makes the version bump mean something", () => {
    // The unit half of ADR 033 §4's degradation proof. Version 1 sent the scope
    // *as* the frame type with a bare id field; this server understands none of
    // those names, so each is a protocol error. The end-to-end half — that the real
    // Web client ends up polling rather than dead — is proved over a real socket by
    // `scripts/verify-live-relay/verify.cjs`, because a mismatched-protocol path is
    // otherwise reached only during a bad upgrade window.
    for (const v1 of [
      { type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID },
      { type: "subscribe_design", projectId: PROJECT_ID, sessionId: SESSION_ID },
      { type: "subscribe_test", projectId: PROJECT_ID, testId: TEST_ID },
      { type: "unsubscribe", featureId: FEATURE_ID },
      { type: "unsubscribe_design", sessionId: SESSION_ID },
      { type: "unsubscribe_test", testId: TEST_ID },
    ]) {
      expect(parseClientFrame(JSON.stringify(v1))).toBeNull();
    }
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
      reviewFindings: null,
      actionItems: null,
      snapshot: null,
      forkStage: null,
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
      reviewFindings: null,
      actionItems: null,
      snapshot: null,
      forkStage: null,
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

  it("is 2, because ADR 033 replaced version 1's frames", () => {
    // Pinned rather than only range-checked: the number is the whole signal a
    // client has that the wire changed, and the Web client's protocol value is
    // written against it. A silent change back to 1 would make an upgraded client
    // believe an old server understands scopes.
    expect(LIVE_PROTOCOL_VERSION).toBe(2);
  });
});

describe("delta payload contract", () => {
  const delta = { scope: featureScope, jobId: JOB_ID, text: "Hello " };

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
        type: "delta",
        scope: featureScope,
        // Verbatim, whitespace included: the client concatenates these, so a
        // trimmed chunk would corrupt the streamed text.
        text: "Hello ",
      },
    });
  });

  it("round-trips a design session's delta, which is issue #95 itself", () => {
    // The behaviour #95 asked for: a design session's prose streams. Before
    // ADR 033 the payload carried a `featureId` and the publisher returned early
    // when it was null, so a `design_grill` job — which has no feature — could
    // never relay a delta at all.
    const payload = encodeDeltaPayload({ scope: designScope, jobId: JOB_ID, text: "a mockup" });
    expect(payload).not.toBeNull();
    expect(deltaFromPayload(payload!)).toEqual({
      topic: `design:${SESSION_ID}`,
      frame: { type: "delta", scope: designScope, text: "a mockup" },
    });
  });

  it("routes a test scope's delta to the test topic", () => {
    const payload = encodeDeltaPayload({ scope: testScope, jobId: JOB_ID, text: "running" });
    expect(deltaFromPayload(payload!)?.topic).toBe(`test:${TEST_ID}`);
  });

  it("carries no jobId on the frame, deliberately", () => {
    // ADR 033 §1's frame table has `{type, scope, text}` and no job id. The
    // authoritative `agent_text` that supersedes a delta carries the job, and the
    // payload keeps it for the ceiling and for logging a dropped one. Asserted so
    // a later "helpful" addition is a decision rather than a drift.
    const parsed = deltaFromPayload(encodeDeltaPayload(delta)!);
    expect(parsed?.frame).not.toHaveProperty("jobId");
    expect(parsed?.frame).not.toHaveProperty("featureId");
  });

  it("refuses to encode an empty text, scope id, or job id", () => {
    expect(encodeDeltaPayload({ ...delta, text: "" })).toBeNull();
    expect(encodeDeltaPayload({ ...delta, jobId: "" })).toBeNull();
    expect(encodeDeltaPayload({ ...delta, scope: { kind: "feature", id: "" } })).toBeNull();
  });

  it("refuses to encode a scope with an unknown kind", () => {
    // Impossible for a typed caller, which is why it is worth a test: the last
    // point before this becomes an unparseable box on the wire is here, and a
    // scope that cannot round-trip would be a delta delivered to no topic.
    expect(
      encodeDeltaPayload({ ...delta, scope: { kind: "job" as never, id: FEATURE_ID } }),
    ).toBeNull();
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
    const parsed = deltaFromPayload(JSON.stringify({ ...delta, somethingNew: true }));
    expect(parsed?.frame).toMatchObject({ type: "delta" });
  });

  it("returns null for malformed or incomplete payloads", () => {
    expect(deltaFromPayload("not json")).toBeNull();
    expect(deltaFromPayload("null")).toBeNull();
    expect(deltaFromPayload('"a string"')).toBeNull();
    expect(deltaFromPayload(JSON.stringify({ scope: featureScope, jobId: JOB_ID }))).toBeNull();
    expect(deltaFromPayload(JSON.stringify({ ...delta, text: "" }))).toBeNull();
    expect(deltaFromPayload(JSON.stringify({ ...delta, scope: 7 }))).toBeNull();
    // A version-1 payload — `featureId` with no scope — must not be routed by
    // guessing: there is no topic to derive, so it is dropped.
    expect(deltaFromPayload(JSON.stringify({ featureId: FEATURE_ID, jobId: JOB_ID, text: "x" }))).toBeNull();
  });

  it("routes the delta to the scope's topic, not the job", () => {
    // Subscription is by scope (ADR 019 item 9), so a delta for a later job of the
    // same feature must reach the same subscribers.
    const parsed = deltaFromPayload(JSON.stringify({ ...delta, jobId: "job_2" }));
    expect(parsed?.topic).toBe(`feature:${FEATURE_ID}`);
  });
});
