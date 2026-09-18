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

/*
 * Issue #68. `isRouter` required `.set`, which Express 4 Routers do not have
 * (that is an *app* method), so every mounted router was wrapped. Routing still
 * worked — a wrapper calling `router(req, res, next)` is functionally
 * equivalent — which is why this survived review and a green suite. What broke
 * was Express's own introspection: a walk of the app's router stack found 1 of
 * 147 routes, because `layer.handle` was a wrapper rather than the router.
 *
 * So these tests assert identity, not behaviour. Behaviour would have passed
 * throughout the bug.
 */
import { Router as ExpressRouter } from "express";

function mountedRouterHandles(app: express.Express): unknown[] {
  const stack = (app as unknown as { _router?: { stack: Array<{ handle: unknown }> } })._router
    ?.stack ?? [];
  return stack.map((layer) => layer.handle);
}

describe("mounted routers keep their identity (issue #68)", () => {
  it("does not wrap a sub-router passed to use()", () => {
    const app = express();
    const sub = ExpressRouter();
    sub.get("/thing", (_req, res) => res.json({ ok: true }));

    app.use("/sub", sub);

    // The mounted layer must *be* the router, not a wrapper around it.
    expect(mountedRouterHandles(app)).toContain(sub);
  });

  it("still finds every route by walking the stack", () => {
    // The concrete symptom: with routers wrapped, an introspection walk finds
    // almost nothing, which is how a test asserting "every route is reachable"
    // reported 1 of 147.
    const app = express();
    const a = ExpressRouter();
    const b = ExpressRouter();
    a.get("/one", (_req, res) => res.json({}));
    a.get("/two", (_req, res) => res.json({}));
    b.post("/three", (_req, res) => res.json({}));

    app.use("/a", a);
    app.use("/b", b);

    const handles = mountedRouterHandles(app);
    expect(handles).toContain(a);
    expect(handles).toContain(b);
    // And their own stacks are intact.
    expect((a as unknown as { stack: unknown[] }).stack).toHaveLength(2);
    expect((b as unknown as { stack: unknown[] }).stack).toHaveLength(1);
  });

  it("still wraps a plain handler passed to use()", async () => {
    // The fix must not swing the other way: a middleware that throws
    // asynchronously is exactly what this module exists for, so it must stay
    // wrapped and still reach an error handler.
    const app = express();
    // Deliberately a path no route answers, so the `use` middleware actually
    // runs — registering it after a matching `get` would let that route respond
    // first and the middleware would never be reached (which is how my first
    // version of this test passed for the wrong reason).
    app.use(async () => {
      throw new Error("middleware exploded");
    });
    app.use(
      (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err instanceof Error ? err.message : "unknown" });
      },
    );

    const res = await request(app).get("/anything");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("middleware exploded");
  });
});
