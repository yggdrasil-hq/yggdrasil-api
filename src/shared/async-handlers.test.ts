import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import "./async-handlers.js";

/**
 * Issue #45. The regression test this was found by *lacking*: before the patch,
 * each of these cases hung until supertest's timeout and the rejection surfaced
 * only as an unhandled error, never as a response.
 *
 * The patched module is imported for its side effect by `app.ts`; importing it
 * here as well is deliberate, so these tests exercise the patch directly rather
 * than only through whatever app a test happens to build.
 */

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const router = express.Router();

  router.get("/throws", async () => {
    throw new Error("repository exploded");
  });
  router.get("/rejects-after-await", async () => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    throw new Error("failed after a real await");
  });
  router.get("/ok", async (_req, res) => {
    res.json({ ok: true });
  });
  // The `router.route(path).get(handler)` form takes a different path through
  // Express, so it needs its own case.
  router.route("/via-route").get(async () => {
    throw new Error("threw through .route()");
  });
  // A synchronous throw was already handled by Express; asserted so the patch
  // is not silently the only thing making it work.
  router.get("/sync-throw", () => {
    throw new Error("synchronous failure");
  });
  // Error middleware must keep its four-argument shape, or Express stops
  // treating it as an error handler at all.
  router.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : "unknown" });
  });

  app.use("/t", router);
  return app;
}

describe("async handlers reach the error middleware (issue #45)", () => {
  it("answers 500 rather than hanging when an async handler throws", async () => {
    const res = await request(buildApp()).get("/t/throws");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "repository exploded" });
  });

  it("does the same when the throw comes after an await", async () => {
    // The realistic shape: the rejection is not synchronous, so nothing about
    // the handler's own call frame can catch it.
    const res = await request(buildApp()).get("/t/rejects-after-await");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("failed after a real await");
  });

  it("covers the .route(path).get(handler) form", async () => {
    const res = await request(buildApp()).get("/t/via-route");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("threw through .route()");
  });

  it("still handles a synchronous throw", async () => {
    const res = await request(buildApp()).get("/t/sync-throw");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("synchronous failure");
  });

  it("does not change what a working handler returns", async () => {
    const res = await request(buildApp()).get("/t/ok");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("leaves a four-argument error handler recognisable as one", async () => {
    // If the wrapper had changed its arity, Express would treat it as ordinary
    // middleware and this would be 404 — there would be no error handler at all.
    const res = await request(buildApp()).get("/t/throws");
    expect(res.status).toBe(500);
  });
});
