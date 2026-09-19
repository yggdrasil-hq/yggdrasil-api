const { WebSocket } = require("ws");

const COOKIE = "yggdrasil_session=66666666-6666-4666-8666-666666666666";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "relay-verify-token";
const API_A = "http://rv-api-a:3000";
const API_B = "http://rv-api-b:3000";
// nginx only proxies `/api/`, and its `proxy_pass` strips that prefix — so an
// internal route is reached through the proxy as `http://rv-nginx/api/internal/...`.
// Using the bare host 404s, which is what my first version of this harness did.
const NGINX = "http://rv-nginx";
const NGINX_API = "http://rv-nginx/api";
const WS_A = "ws://rv-api-a:3000/ws";
const WS_B = "ws://rv-api-b:3000/ws";
const WS_NGINX = "ws://rv-nginx/api/ws";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const FEATURE_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
// Issue #25: a `design_grill` job with no feature — so its events reach nobody
// through the feature topic and must arrive on `design:<id>` instead.
const DESIGN_JOB_ID = "77777777-7777-4777-8777-777777777777";
// Issue #90: the `tests` row, and a scheduled `test_run` pointing at it with no
// feature — the shape whose events reached no socket before `test:` existed.
const TEST_ID = "99999999-9999-4999-8999-999999999999";
const SCHEDULED_TEST_JOB_ID = "88888888-8888-4888-8888-888888888888";
// Issue #100: a **feature-driven** `test_run`, carrying both a `feature_id` and a
// `test_id`. One job with two surfaces, so one event must reach two topics.
const FEATURE_DRIVEN_TEST_JOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDLE_SECONDS = Number(process.env.IDLE_SECONDS || 90);

const results = [];
let marker = 0;
const nextMarker = () => `relay-verify-${Date.now()}-${++marker}`;
const host = (u) => u.replace(/^(ws|http):\/\//, "").replace(/\/.*$/, "");

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? " — " + detail : ""));
}

async function waitFor(frames, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The two scopes these checks subscribe to, in ADR 033 §1's shape.
 *
 * `design_session`'s id is the **job** id, not a feature id: a design session is a
 * `design_grill` job, and the REST route resolves its `:sessionId` that way.
 */
const FEATURE_SCOPE = { kind: "feature", id: FEATURE_ID };
const DESIGN_SCOPE = { kind: "design_session", id: DESIGN_JOB_ID };
const TEST_SCOPE = { kind: "test", id: TEST_ID };

/**
 * Subscribes, returning the socket and its frames.
 *
 * `scope` **is** the parameter now, where this used to take a `{type, id}` and map it
 * onto a scope name inside. ADR 033 §1's conclusion applied to the harness: one frame
 * shape serves every scope, so the scope is the only thing that varies and passing it
 * directly removes a translation step that could disagree with the wire. Defaulted to
 * the feature so the calls that predate the `test` scope read unchanged.
 */
async function subscribe(wsUrl, scope = FEATURE_SCOPE) {
  const frames = [];
  let closed = null;
  const ws = new WebSocket(wsUrl, { headers: { Cookie: COOKIE } });
  // Attached before awaiting `open`, so nothing the server sends can be missed
  // (a `ready` frame emitted before a listener exists is simply lost).
  ws.on("message", (data) => {
    try { frames.push(JSON.parse(data.toString())); }
    catch { frames.push({ type: "<unparseable>", raw: data.toString() }); }
  });
  ws.on("close", (code, reason) => { closed = { code, reason: reason && reason.toString() }; });
  ws.on("error", (e) => { closed = { error: e.message }; });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out opening " + wsUrl)), 15000);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (e) => { clearTimeout(timer); reject(new Error("socket error on " + wsUrl + ": " + e.message)); });
  });

  // Wait for `ready` before subscribing. NOT cosmetic: a frame sent before that
  // is SILENTLY DROPPED by the server — reproduced, and filed as its own issue —
  // because `openConnection` awaits a session lookup before attaching its
  // `message` listener, so anything sent in that window is lost rather than
  // buffered. The socket stays open and still answers `ping`, so a client that
  // subscribes on `open` looks connected and receives nothing, forever. The Web
  // app happens to wait for `ready`, which is why this has never surfaced.
  const ready = await waitFor(frames, (f) => f.type === "ready", 15000);
  if (!ready) throw new Error("no `ready` frame on " + wsUrl + "; frames=" + JSON.stringify(frames));
  ws.send(JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, scope }));
  // The confirmation is one frame name carrying the scope, so it is matched on the
  // *scope* rather than on a per-scope frame name — the check is what stops a
  // confirmation for some other resource being read as this subscription's.
  const first = await waitFor(
    frames,
    (f) =>
      (f.type === "subscribed" && sameScope(f.scope, scope)) || f.type === "error",
    15000,
  );
  if (!first || first.type !== "subscribed") {
    throw new Error(
      "subscribe refused on " + wsUrl +
      ": firstFrame=" + JSON.stringify(first) +
      " frames=" + JSON.stringify(frames) +
      " close=" + JSON.stringify(closed),
    );
  }
  return { ws, frames };
}

/** Whether a frame's `scope` field names exactly `scope`. */
function sameScope(frameScope, scope) {
  return (
    typeof frameScope === "object" &&
    frameScope !== null &&
    frameScope.kind === scope.kind &&
    frameScope.id === scope.id
  );
}

async function postEvent(baseUrl, body, jobId = JOB_ID) {
  const res = await fetch(baseUrl + "/internal/jobs/" + jobId + "/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + INTERNAL_TOKEN },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A stored event written through writeUrl must reach a socket held by a
// different process. This is the claim #32 calls "the load-bearing one".
async function storedEventCrossProcess({ name, wsUrl, writeUrl }) {
  const { ws, frames } = await subscribe(wsUrl);
  try {
    const text = nextMarker();
    const { status } = await postEvent(writeUrl, { type: "agent_text", message: text });
    if (status !== 201) { record(name, false, "event write returned " + status); return; }
    const frame = await waitFor(
      frames,
      (f) => f.type === "event" && sameScope(f.scope, FEATURE_SCOPE) && f.event && f.event.message === text,
      15000,
    );
    record(name, Boolean(frame),
      frame ? "delivered (socket=" + host(wsUrl) + ", write=" + host(writeUrl) + ")"
            : "NOT delivered within 15s (socket=" + host(wsUrl) + ", write=" + host(writeUrl) + ")");
  } finally { ws.close(); }
}

/*
 * Issue #25: the design topic, cross-process.
 *
 * Written by one replica and observed on a socket held by another, which is the
 * same load-bearing claim #32 measured for the feature topic — and the one that
 * matters for a *new* topic, because a routing mistake here is invisible to a
 * single-process test by construction. The frame type asserted is
 * the *scope*, not the frame name, so this pins that the two topic families produce
 * differently-scoped frames rather than the design one borrowing the feature scope and
 * putting a session id where a feature id belongs. Under ADR 033 §1 that distinction
 * lives in the tag rather than in the frame's name — which is exactly why it needs
 * asserting, since there is no longer a type difference to catch it.
 */
async function designSessionCrossProcess({ name, wsUrl, writeUrl }) {
  const { ws, frames } = await subscribe(wsUrl, DESIGN_SCOPE);
  try {
    const marker = nextMarker();
    const { status } = await postEvent(
      writeUrl,
      {
        type: "update_design_preview",
        // Relative, not absolute: `designSnapshotSchema` rejects a leading "/"
        // ("paths must be safe relative paths"). My first version used
        // "/index.html" and every design write 400'd — the schema doing its job.
        snapshot: { "index.html": "<html>" + marker + "</html>" },
      },
      DESIGN_JOB_ID,
    );
    if (status !== 201) { record(name, false, "design event write returned " + status); return; }

    const frame = await waitFor(
      frames,
      (f) =>
        f.type === "event" &&
        sameScope(f.scope, DESIGN_SCOPE) &&
        f.event &&
        f.event.snapshot &&
        String(f.event.snapshot["index.html"] || "").includes(marker),
      15000,
    );
    record(name, Boolean(frame),
      frame ? "delivered on design topic (socket=" + host(wsUrl) + ", write=" + host(writeUrl) + ")"
            : "NOT delivered within 15s (socket=" + host(wsUrl) + ", write=" + host(writeUrl) + ")");
  } finally { ws.close(); }
}

/**
 * The negative half, and it has to be aimed at something that *could* happen.
 *
 * **My first version of this was not.** It subscribed to the feature topic and
 * wrote a design event, asserting nothing arrived — which could never have failed:
 * the fixture design job has no `feature_id`, so its events cannot reach any
 * feature topic even if the routing were wrong, because the topic it would be
 * mis-routed to is `feature:<designJobId>`, not the one under test. A negative case
 * that cannot fail is worse than none, because it reads as coverage.
 *
 * This instead watches the **design** topic and writes a **feature** event. That is
 * a real risk: a router that confused the two id spaces — both are uuids from the
 * same source — or that fanned one event onto every topic, would show up here and
 * nowhere else. Cross-process, like the positive case, so the LISTEN/NOTIFY path is
 * exercised rather than a same-process publish.
 */
async function featureEventStaysOffTheDesignTopic({ name, wsUrl, writeUrl }) {
  const { ws, frames } = await subscribe(wsUrl, DESIGN_SCOPE);
  try {
    const marker = nextMarker();
    const { status } = await postEvent(writeUrl, { type: "agent_text", message: marker });
    if (status !== 201) { record(name, false, "feature event write returned " + status); return; }

    // The positive case's own window, so "nothing arrived" is a real absence rather
    // than a race the assertion happened to win.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const leaked = frames.some(
      (f) => f.type === "event" && f.event && f.event.message === marker,
    );
    record(
      name,
      !leaked,
      leaked ? "LEAKED onto the design topic" : "stayed off the design topic",
    );
  } finally { ws.close(); }
}

/*
 * Issue #90: the `test:` topic, cross-process, for a **scheduled** run.
 *
 * The shape is a `test_id` and no `feature_id`, so before the `test` scope existed
 * this job's events reached no socket at all — the page could only poll. Cross-process
 * like every other positive here, because a routing mistake is unobservable within a
 * single process.
 *
 * Written to `agent_text` rather than a `report_test_step`: the internal route accepts
 * both on a `test_run`, and `agent_text` has no side effect on the feature, which keeps
 * this check about the *route to the topic* rather than about what the event does.
 */
async function scheduledTestRunCrossProcess({ name, wsUrl, writeUrl }) {
  const { ws, frames } = await subscribe(wsUrl, TEST_SCOPE);
  try {
    const marker = nextMarker();
    const { status } = await postEvent(
      writeUrl,
      { type: "agent_text", message: marker },
      SCHEDULED_TEST_JOB_ID,
    );
    if (status !== 201) { record(name, false, "event write returned " + status); return; }

    const frame = await waitFor(
      frames,
      (f) => f.type === "event" && sameScope(f.scope, TEST_SCOPE) && f.event && f.event.message === marker,
      15000,
    );
    record(name, Boolean(frame),
      frame ? "delivered on test topic (socket=" + host(wsUrl) + ", write=" + host(writeUrl) + ")"
            : "NOT delivered within 15s (socket=" + host(wsUrl) + ", write=" + host(writeUrl) + ")");
  } finally { ws.close(); }
}

/*
 * Issue #100: **one write, two topics** — the whole claim, and it is a conjunction.
 *
 * Two sockets on two different topics, one event posted to a job that carries both a
 * `feature_id` and a `test_id`. Both halves are asserted from the same write, because
 * "the second delivery was added" and "the first was kept" are separate claims and a
 * fix that traded one for the other would satisfy either alone. The detail line names
 * whichever half failed, so a failure says *which* surface went dark.
 *
 * The scope check is what pins the decision's "one envelope per scope, each carrying
 * its own tag" rather than one frame with two scopes: a `test:` socket is matched on
 * `scope.kind === "test"`, so a frame that named the feature — or that carried both —
 * would not satisfy it. That is also the failure the Web client would suffer, since
 * `eventFromFrame` drops a frame whose scope is not its own.
 *
 * Cross-process like the rest: written by one replica, observed on sockets held by the
 * other, so the LISTEN/NOTIFY fan-out is exercised rather than a same-process publish.
 */
async function featureDrivenTestRunReachesBothTopics({ name, featureWsUrl, testWsUrl, writeUrl }) {
  const feature = await subscribe(featureWsUrl, FEATURE_SCOPE);
  const test = await subscribe(testWsUrl, TEST_SCOPE);
  try {
    const marker = nextMarker();
    const { status } = await postEvent(
      writeUrl,
      { type: "agent_text", message: marker },
      FEATURE_DRIVEN_TEST_JOB_ID,
    );
    if (status !== 201) { record(name, false, "event write returned " + status); return; }

    const onFeature = await waitFor(
      feature.frames,
      (f) => f.type === "event" && sameScope(f.scope, FEATURE_SCOPE) && f.event && f.event.message === marker,
      15000,
    );
    const onTest = await waitFor(
      test.frames,
      (f) => f.type === "event" && sameScope(f.scope, TEST_SCOPE) && f.event && f.event.message === marker,
      15000,
    );

    record(
      name,
      Boolean(onFeature) && Boolean(onTest),
      "one write -> featureTopic=" + (onFeature ? "received" : "MISSING") +
        " testTopic=" + (onTest ? "received" : "MISSING") +
        " (feature socket=" + host(featureWsUrl) + ", test socket=" + host(testWsUrl) +
        ", write=" + host(writeUrl) + ")",
    );
  } finally {
    feature.ws.close();
    test.ws.close();
  }
}

/**
 * The negative half for issue #100, and it is aimed at the mistake the *plural* return
 * makes newly possible: fanning out too far.
 *
 * A job with a feature and **no** `test_id` (`JOB_ID`, the `spec_grill` fixture) must
 * not reach any test topic. The project *does* have a test and the feature *does* have a
 * feature-driven run pointing at it, so "publish to every topic this project has" — or a
 * `test:` branch keyed on the job's kind instead of on `test_id` being present — would
 * show up exactly here and nowhere else.
 *
 * Watching the **test** topic while writing a **feature-only** job's event is the
 * direction that can actually fail. Aiming it the other way round (watching the feature
 * topic for a scheduled run) could never fail, because such a job has no feature to
 * mis-route to — the same mistake the design-topic negative's comment records making
 * once already. A negative case that cannot fail is worse than none, because it reads as
 * coverage.
 */
async function featureOnlyJobStaysOffTheTestTopic({ name, wsUrl, writeUrl }) {
  const { ws, frames } = await subscribe(wsUrl, TEST_SCOPE);
  try {
    const marker = nextMarker();
    const { status } = await postEvent(writeUrl, { type: "agent_text", message: marker });
    if (status !== 201) { record(name, false, "feature event write returned " + status); return; }

    // The positive cases' own window, so "nothing arrived" is a real absence rather
    // than a race this assertion happened to win.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const leaked = frames.some(
      (f) => f.type === "event" && f.event && f.event.message === marker,
    );
    record(
      name,
      !leaked,
      leaked ? "LEAKED onto the test topic" : "stayed off the test topic",
    );
  } finally { ws.close(); }
}

/**
 * ADR 033 §4: a version-1 client meeting a version-2 server must end up **polling,
 * not dead** — proved over a real WebSocket, which is what the ADR makes a condition of
 * replacing version 1 rather than keeping it alongside.
 *
 * **Why this is a condition and not a claim.** The degradation is the whole argument for
 * removing version-1's frames instead of maintaining two parsers: the only client ships
 * in the same image as the server, so a compatibility window would protect a client that
 * cannot exist. That argument rests on the mismatch path behaving — and a
 * mismatched-protocol path is reached *only* during a bad upgrade window, which is
 * precisely the path that never gets exercised and quietly rots. So it is exercised
 * here, on every run of this harness, rather than reasoned about in a comment.
 *
 * The check has three parts, and all three are needed:
 *
 *  1. `ready` announces **version 2**, so the version number matches the wire — the
 *     lever the whole decision uses, and the one thing a client can compare.
 *  2. A version-1 frame is answered with an `error` frame naming it as unrecognised.
 *     This is the frame `web/lib/features/live-relay.ts` treats as **terminal**: it
 *     calls `stop()` and leaves the socket closed, so the page falls back to its own
 *     fast poll. That is "polling rather than dead".
 *  3. The socket is left **open and unsubscribed**, not closed. A server that closed it
 *     with a retryable code would send a client into its reconnect backoff — ten
 *     attempts over a minute — which is the *dead-ish* outcome this is checking against.
 *
 * And a positive control, without which part 3 would pass for a socket that is inert for
 * some unrelated reason: the same connection then sends the version-2 frame, is
 * confirmed, and receives a published event.
 *
 * The client half of the pairing — that those two frames leave the real client on its
 * poll rather than live — is asserted against the real client in
 * `web/src/features/live-relay.test.ts`, using the frame sequence recorded from here.
 */
async function version1ClientDegradesToPolling({ name, wsUrl, writeUrl }) {
  const frames = [];
  let closeInfo = null;
  const ws = new WebSocket(wsUrl, { headers: { Cookie: COOKIE } });
  ws.on("message", (data) => {
    try { frames.push(JSON.parse(data.toString())); }
    catch { frames.push({ type: "<unparseable>", raw: data.toString() }); }
  });
  ws.on("close", (code, reason) => { closeInfo = { code, reason: reason && reason.toString() }; });
  ws.on("error", (e) => { closeInfo = { error: e.message }; });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out opening " + wsUrl)), 15000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (e) => { clearTimeout(timer); reject(new Error("socket error on " + wsUrl + ": " + e.message)); });
    });

    const ready = await waitFor(frames, (f) => f.type === "ready", 15000);
    if (!ready) { record(name, false, "no `ready` frame on " + wsUrl); return; }
    if (ready.protocolVersion !== 2) {
      record(name, false, "`ready` announced protocolVersion " + ready.protocolVersion + ", not 2");
      return;
    }

    // Version 1's frame, byte for byte: the scope named by the frame *type* and a bare
    // `featureId` where a scope belongs.
    ws.send(JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, featureId: FEATURE_ID }));

    const error = await waitFor(frames, (f) => f.type === "error", 15000);
    if (!error) {
      record(name, false, "a version-1 subscribe frame produced no error frame; frames=" + JSON.stringify(frames));
      return;
    }

    // Part 3: inert but alive, not closed. Give the server a moment to close it if it
    // were going to, then publish and confirm nothing arrives.
    const text = nextMarker();
    const { status } = await postEvent(writeUrl, { type: "agent_text", message: text });
    if (status !== 201) { record(name, false, "event write returned " + status); return; }
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const delivered = frames.some((f) => f.type === "event" && f.event && f.event.message === text);
    const stillOpen = ws.readyState === ws.OPEN;

    // Positive control: the same socket speaks version 2 and works.
    ws.send(JSON.stringify({ type: "subscribe", projectId: PROJECT_ID, scope: FEATURE_SCOPE }));
    const confirmed = await waitFor(
      frames,
      (f) => f.type === "subscribed" && sameScope(f.scope, FEATURE_SCOPE),
      15000,
    );
    const controlText = nextMarker();
    await postEvent(writeUrl, { type: "agent_text", message: controlText });
    const controlFrame = await waitFor(
      frames,
      (f) => f.type === "event" && f.event && f.event.message === controlText,
      15000,
    );

    const ok =
      !delivered &&
      stillOpen &&
      Boolean(confirmed) &&
      Boolean(controlFrame) &&
      !closeInfo;

    record(
      name,
      ok,
      ok
        ? "ready=v2, v1 frame refused with error (" + JSON.stringify(error.message) + "), " +
          "nothing delivered while unsubscribed, socket still open, and the same socket " +
          "subscribed and delivered under version 2"
        : "deliveredWhileUnsubscribed=" + delivered +
          " stillOpen=" + stillOpen +
          " confirmedUnderV2=" + Boolean(confirmed) +
          " controlDelivered=" + Boolean(controlFrame) +
          " close=" + JSON.stringify(closeInfo),
    );
  } finally {
    ws.close();
  }
}

async function deltaCrossProcess({ name, wsUrl, writeUrl, message, expectDelivery }) {
  const { ws, frames } = await subscribe(wsUrl);
  try {
    const text = message || nextMarker();
    const { status } = await postEvent(writeUrl, { type: "agent_text_delta", message: text });
    const frame = await waitFor(
      frames,
      (f) => f.type === "delta" && sameScope(f.scope, FEATURE_SCOPE) && f.text === text,
      8000,
    );
    if (expectDelivery) {
      record(name, Boolean(frame), frame ? "delivered (write=" + host(writeUrl) + ")" : "NOT delivered (write=" + host(writeUrl) + ")");
    } else {
      // Issue #78: the route now rejects an oversize payload (400) instead of
      // accepting it (202) and letting the publisher drop it. The assertion is
      // the *invariant*, not the old symptom: nothing was accepted-and-lost.
      //
      // Before the fix this expected `202 && !frame` — which is precisely the
      // silent drop, encoded as a pass. A verification that asserts the bug is
      // worse than no verification, because it certifies the bug.
      record(name, status === 400 && !frame,
        "route refused (" + status + "), nothing delivered, payload " + Buffer.byteLength(text) + " bytes");
    }
  } finally { ws.close(); }
}

async function waitHealthy(name, url, path) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try { const r = await fetch(url + (path || "/health")); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  record("readiness: " + name, false, "never became healthy at " + url + (path || "/health"));
  return false;
}

async function main() {
  // nginx only proxies /api/, so its health check goes through the proxy path —
  // which also proves the proxy is routing at all, rather than just that a
  // container is up.
  for (const [n, u, path] of [
    ["rv-api-a", API_A, "/health"],
    ["rv-api-b", API_B, "/health"],
    ["rv-nginx (via /api/)", NGINX, "/api/health"],
  ]) {
    if (!(await waitHealthy(n, u, path))) { summary(); return; }
  }
  record("readiness: both replicas and nginx", true, "all answered /health");

  // ADR 033 §4's condition, first because it is the one check here whose failure mode is
  // "nobody ever runs this path".
  await version1ClientDegradesToPolling({
    name: "version-1 client: refused as unrecognised, left subscribed to nothing, and still usable under version 2",
    wsUrl: WS_A, writeUrl: API_B,
  });

  // Control: without this, a cross-process success could be explained by
  // something other than the fan-out.
  await storedEventCrossProcess({
    name: "stored event, same process (control): write api-a -> socket api-a",
    wsUrl: WS_A, writeUrl: API_A,
  });
  await storedEventCrossProcess({
    name: "stored event across replicas: write api-b -> socket api-a",
    wsUrl: WS_A, writeUrl: API_B,
  });
  await storedEventCrossProcess({
    name: "stored event across replicas (reverse): write api-a -> socket api-b",
    wsUrl: WS_B, writeUrl: API_A,
  });
  await deltaCrossProcess({
    name: "streaming delta across replicas: write api-b -> socket api-a",
    wsUrl: WS_A, writeUrl: API_B, expectDelivery: true,
  });

  // The payload bound, at the boundary that used to be two different boundaries.
  //
  // Issue #78 fixed the mismatch these cases documented: the route counted
  // characters and the publisher counted bytes, so multi-byte text was accepted
  // by the route and dropped by the publisher. Both now ask the publisher's own
  // question, so these assert the *invariant* rather than the discrepancy —
  // anything the route accepts is delivered.
  const ascii = "a".repeat(6000);
  await deltaCrossProcess({
    name: "delta well inside the payload bound, ASCII (~" + Buffer.byteLength(ascii) + " bytes)",
    wsUrl: WS_A, writeUrl: API_B, message: ascii, expectDelivery: true,
  });

  // The case that was the bug: 4000 three-byte characters is 12000 bytes, over
  // the publisher's 7000-byte ceiling. The route now rejects it too, so nothing
  // is silently dropped — the write is refused rather than accepted-and-lost.
  const multiByte = "\u4e2d".repeat(4000);
  await deltaCrossProcess({
    name: "multi-byte text over the payload bound is refused by the route (~" +
      Buffer.byteLength(multiByte) + " bytes)",
    wsUrl: WS_A, writeUrl: API_B, message: multiByte, expectDelivery: false,
  });

  // And a multi-byte payload that *fits* must still be delivered — the fix must
  // not have narrowed the bound to ASCII.
  const multiByteFits = "\u4e2d".repeat(1500);
  await deltaCrossProcess({
    name: "multi-byte text inside the payload bound is delivered (~" +
      Buffer.byteLength(multiByteFits) + " bytes)",
    wsUrl: WS_A, writeUrl: API_B, message: multiByteFits, expectDelivery: true,
  });

  await storedEventCrossProcess({
    name: "through nginx: socket + write both via the proxy",
    wsUrl: WS_NGINX, writeUrl: NGINX_API,
  });

  // Issue #25: the design-session topic, which is the second topic *shape* the
  // relay gained. Cross-process like the feature cases above, because a routing
  // mistake is unobservable in a single process.
  await designSessionCrossProcess({
    name: "design session: event across replicas on its own topic",
    wsUrl: WS_A, writeUrl: API_B,
  });

  // And the negative half, aimed at a mistake that could actually be made: the
  // two id spaces are both uuids, so a router that confused them would put a
  // feature's events on the design topic.
  await featureEventStaysOffTheDesignTopic({
    name: "feature event stays off the design topic",
    wsUrl: WS_A, writeUrl: API_B,
  });

  // Issue #90: the third topic shape, and the one whose authorisation is newest —
  // a scheduled run, which has a `test_id` and no feature to route by.
  await scheduledTestRunCrossProcess({
    name: "scheduled test_run: event across replicas on the test topic",
    wsUrl: WS_A, writeUrl: API_B,
  });

  // Issue #100: the fan-out. One job with two surfaces, so one write must arrive on
  // both topics — the check that fails if either delivery is lost.
  await featureDrivenTestRunReachesBothTopics({
    name: "feature-driven test_run: one write reaches both the feature topic and the test topic",
    featureWsUrl: WS_A, testWsUrl: WS_B, writeUrl: API_B,
  });

  // And its negative: a job with no `test_id` must not reach a test topic, which is
  // the mistake a plural return makes newly possible.
  await featureOnlyJobStaysOffTheTestTopic({
    name: "feature-only job stays off the test topic",
    wsUrl: WS_A, writeUrl: API_B,
  });

  // An idle socket through nginx. nginx's *default* proxy_read_timeout is 60s and
  // the product sets 3600s; sitting idle past 60s and still receiving is what
  // distinguishes the configured value from the default. A socket nginx had cut
  // would look fine to a client that had not tried to use it yet.
  {
    const { ws, frames } = await subscribe(WS_NGINX);
    try {
      const started = Date.now();
      await new Promise((r) => setTimeout(r, IDLE_SECONDS * 1000));
      ws.send(JSON.stringify({ type: "ping" }));
      const pong = await waitFor(frames, (f) => f.type === "pong", 10000);
      const text = nextMarker();
      await postEvent(NGINX_API, { type: "agent_text", message: text });
      const frame = await waitFor(
      frames,
      (f) => f.type === "event" && sameScope(f.scope, FEATURE_SCOPE) && f.event && f.event.message === text,
      15000,
    );
      record("idle " + IDLE_SECONDS + "s through nginx (default read_timeout is 60s), then delivered",
        Boolean(pong) && Boolean(frame),
        pong && frame ? "survived " + Math.round((Date.now() - started) / 1000) + "s idle and still delivered"
                      : "pong=" + Boolean(pong) + " frame=" + Boolean(frame) + " — socket did not survive the idle period");
    } finally { ws.close(); }
  }

  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("checks: " + results.length + ", passed: " + (results.length - failed.length) + ", failed: " + failed.length);
  if (failed.length) { console.log("failed checks:"); for (const f of failed) console.log("  - " + f.name + ": " + f.detail); }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { record("verification harness", false, "threw: " + (e.stack || e.message)); summary(); });
