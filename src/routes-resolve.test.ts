import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

/**
 * Issue #56's lesson, made permanent: **a route that exists is not the same as a
 * route the app serves.**
 *
 * #56 was a production outage — four usage/analytics pages 404'd — and every test
 * passed, because `usage/routes.test.ts` mounted the router at root while
 * `app.ts` mounts it at a prefix. The unit was right and the composition was
 * wrong, and nothing covered the composition. #59 was the same shape from the
 * other direction: the Web client had been calling a path the API never
 * registered, and neither side's tests could tell.
 *
 * So this file does not test a router. It builds the **real app** and asserts the
 * paths the Web client actually calls resolve through it.
 *
 * **The discriminator is 401-vs-404, and that is what makes this robust.** These
 * routes require a session, so a live request without one answers `401` — the
 * route matched and its middleware ran. An unregistered path answers `404`
 * ("Cannot GET"). Asserting "not 404" therefore tests *routing only*, with no
 * database, no fixtures, and no auth, which is exactly the layer these two bugs
 * lived at.
 *
 * A control case asserts a nonsense path still 404s, so the test cannot pass by
 * the app answering 401 to everything.
 */

/** A pool stand-in: `createApp` needs one to take its real branch, and auth rejects before any query runs. */
const pool = { query: vi.fn(async () => ({ rows: [] })) };

function app(): express.Express {
  // Without a pool, `createApp` deliberately returns a minimal app with only
  // `/health` — which is how an earlier probe concluded the app was broken.
  return createApp({ pool } as never);
}

/**
 * The paths the Web client builds, taken from `lib/api.ts`'s `apiUrl(...)` calls.
 *
 * Named individually rather than generated, because the point is to pin the
 * *contract* — a path is only in this list if a Web function builds it, so a
 * rename on either side has to change this file.
 */
const WEB_CALLED_PATHS = [
  // Issue #59: the Agentic Review tab. Called since the tab was built; 404'd for
  // its whole life because no read endpoint existed.
  "/projects/11111111-1111-4111-8111-111111111111/features/22222222-2222-4222-8222-222222222222/agentic-review",
  // Issue #56: the four paths that were mounted at doubled prefixes.
  "/organizations/33333333-3333-4333-8333-333333333333/usage",
  "/organizations/33333333-3333-4333-8333-333333333333/analytics",
  "/projects/11111111-1111-4111-8111-111111111111/usage",
  "/projects/11111111-1111-4111-8111-111111111111/analytics",
  // The timezone *setting* is read off the project response rather than a GET on
  // its own path — `PUT /:projectId/timezone` is the write half, and the read half
  // is `PublicProject.timeZone`. Asserted in the project-type test instead, since
  // this list is about routing.
  // Neighbours worth pinning: the same shape, so a refactor that fixes one and
  // breaks the next is caught in the same run.
  "/projects/11111111-1111-4111-8111-111111111111/features/22222222-2222-4222-8222-222222222222/testing",
  "/projects/11111111-1111-4111-8111-111111111111/deploys",
  "/projects/11111111-1111-4111-8111-111111111111/tests",
  "/settings/notification-preferences",
  "/notifications",
] as const;

describe("the paths the Web client calls resolve through the real app", () => {
  it.each(WEB_CALLED_PATHS)("resolves GET %s", async (path) => {
    const res = await request(app()).get(path);

    // 401 means the route exists and its auth middleware ran; 200 would mean it
    // is public. Either is a pass — 404 is a routing failure, which is the bug.
    expect(
      res.status,
      `${path} is not registered on the app (404) — the Web client calls it`,
    ).not.toBe(404);
  });

  it("is genuinely testing routing, not a blanket 401", async () => {
    // The control. Without it, an app that answered 401 to every path — a
    // misconfigured catch-all, say — would make every case above pass.
    const res = await request(app()).get("/definitely-not-a-registered-path");

    expect(res.status).toBe(404);
  });

  /**
   * Method-scoped on purpose: the timezone route is `PUT`-only, so a `GET` on the
   * same path is **correctly** a 404. My first version of this file listed it as a
   * GET and this test caught me — which is the file doing its job, so the case is
   * kept as a named assertion rather than removed.
   */
  it("resolves PUT /projects/:id/timezone, which is a different method", async () => {
    // Method-scoped: a GET-only check would pass for a route registered as GET
    // when the client PUTs, which is a real way to get 404.
    const res = await request(app())
      .put("/projects/11111111-1111-4111-8111-111111111111/timezone")
      .send({ timeZone: "UTC" });

    expect(res.status).not.toBe(404);
  });

  it("404s a method the route does not support, so the check is method-aware", async () => {
    // `/health` is GET-only. A POST must be 404, proving the assertions above are
    // not passing merely because supertest tolerates any method.
    const res = await request(app()).post("/health");

    expect(res.status).toBe(404);
  });
});
