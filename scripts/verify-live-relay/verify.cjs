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
 * Subscribes, returning the socket and its frames.
 *
 * `target` selects which frame to send, because the two carry different resources
 * with different authorisation rules (issue #25). Defaulted to the feature so the
 * existing calls read unchanged.
 */
async function subscribe(wsUrl, target = { type: "feature", id: FEATURE_ID }) {
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
  const subscribeFrame =
    target.type === "design"
      ? { type: "subscribe_design", projectId: PROJECT_ID, sessionId: target.id }
      : { type: "subscribe", projectId: PROJECT_ID, featureId: target.id };
  ws.send(JSON.stringify(subscribeFrame));
  const first = await waitFor(
    frames,
    (f) => f.type === "subscribed" || f.type === "subscribed_design" || f.type === "error",
    15000,
  );
  if (!first || (first.type !== "subscribed" && first.type !== "subscribed_design")) {
    throw new Error(
      "subscribe refused on " + wsUrl +
      ": firstFrame=" + JSON.stringify(first) +
      " frames=" + JSON.stringify(frames) +
      " close=" + JSON.stringify(closed),
    );
  }
  return { ws, frames };
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
    const frame = await waitFor(frames, (f) => f.type === "job_event" && f.event && f.event.message === text, 15000);
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
 * `design_session_event`, not `job_event`, so this also pins that the two topic
 * families produce different frames rather than the design one borrowing the
 * feature frame and putting a session id in `featureId`.
 */
async function designSessionCrossProcess({ name, wsUrl, writeUrl }) {
  const { ws, frames } = await subscribe(wsUrl, { type: "design", id: DESIGN_JOB_ID });
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
        f.type === "design_session_event" &&
        f.sessionId === DESIGN_JOB_ID &&
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
  const { ws, frames } = await subscribe(wsUrl, { type: "design", id: DESIGN_JOB_ID });
  try {
    const marker = nextMarker();
    const { status } = await postEvent(writeUrl, { type: "agent_text", message: marker });
    if (status !== 201) { record(name, false, "feature event write returned " + status); return; }

    // The positive case's own window, so "nothing arrived" is a real absence rather
    // than a race the assertion happened to win.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const leaked = frames.some(
      (f) =>
        (f.type === "job_event" || f.type === "design_session_event") &&
        f.event &&
        f.event.message === marker,
    );
    record(
      name,
      !leaked,
      leaked ? "LEAKED onto the design topic" : "stayed off the design topic",
    );
  } finally { ws.close(); }
}

async function deltaCrossProcess({ name, wsUrl, writeUrl, message, expectDelivery }) {
  const { ws, frames } = await subscribe(wsUrl);
  try {
    const text = message || nextMarker();
    const { status } = await postEvent(writeUrl, { type: "agent_text_delta", message: text });
    const frame = await waitFor(frames, (f) => f.type === "job_event_delta" && f.text === text, 8000);
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
      const frame = await waitFor(frames, (f) => f.type === "job_event" && f.event && f.event.message === text, 15000);
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
