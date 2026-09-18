import request from "supertest";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

/**
 * Issue #56: the app's **route wiring**, asserted against the real `createApp()`.
 *
 * **Why this file has to exist.** Every other routing test in this repo builds
 * its own `express()` and mounts one router at a prefix of the test's choosing.
 * That is the right way to test a router in isolation, and it is exactly why
 * four endpoints could 404 in every real deployment while the suite stayed
 * green: the usage router registered absolute paths
 * (`/organizations/:id/usage`) and `app.ts` also mounted it at `/organizations`,
 * so Express joined the two and served
 * `/organizations/organizations/:id/usage`. The route tests mounted the same
 * router at *root* — the one arrangement that makes absolute paths resolve — and
 * passed.
 *
 * A unit test that wires a router differently from the application cannot detect
 * a wiring bug. This one wires nothing: it asks the assembled application
 * whether each documented route is reachable, which is the property that broke.
 *
 * **A pool is passed even though nothing queries it.** `createApp()` returns
 * early with only `/health` when `deps.pool` is absent, so calling it bare — as
 * `index.test.ts` does — assembles none of the routers this test is about. The
 * stub is never reached because `requireAuth` answers before any handler runs.
 *
 * **How the assertion distinguishes "registered" from "missing".** A matched
 * route runs `requireAuth` and answers **401**; an unregistered path matches no
 * layer and gets Express's default **404 `Cannot GET …`**. So "not 404" is the
 * signal that a route exists, and it needs no session, no fixtures and no
 * database. The body is checked too, because a handler that deliberately 404s
 * returns JSON while Express's default returns HTML text.
 *
 * **Scope: the documented, user-reachable routes.** `/internal/*` and the GitHub
 * webhook/install routes are excluded — they are token- or state-authenticated
 * machine surfaces rather than pages, and enumerating them here would assert
 * things this issue is not about. The list below is every `GET` route behind a
 * real page, and the four from #56 are among them. A full enumeration of all 147
 * registered routes would need editing on every unrelated addition, and an
 * assertion that must be updated to stay true stops being read.
 */

/** A pool that is constructed against but never queried: auth 401s first. */
const unqueriedPool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;

const ORG = "9718a69f-5530-4806-851e-a6dd7e2aa44d";
const PROJECT = "b51e1313-d315-47bf-be25-038acc16d6a4";

/** Documented user-facing `GET` routes, with their real registered paths. */
const DOCUMENTED_GET_ROUTES = [
  // Account.
  "/auth/me",
  "/settings/notification-preferences",
  "/notifications",
  // Organization settings and monitoring.
  "/organizations",
  "/organizations/roles",
  "/organizations/:organizationId",
  "/organizations/:organizationId/members",
  "/organizations/:organizationId/invites",
  "/organizations/:organizationId/secrets",
  "/organizations/:organizationId/cluster",
  "/organizations/:organizationId/audit",
  "/organizations/:organizationId/providers",
  "/organizations/:organizationId/models",
  "/organizations/:organizationId/job-model-defaults",
  "/organizations/:organizationId/allocations",
  "/organizations/:organizationId/extensions",
  // The four from #56.
  "/organizations/:organizationId/usage",
  "/organizations/:organizationId/analytics",
  // Project-scoped reads.
  "/projects",
  "/projects/:projectId",
  "/projects/:projectId/overview",
  "/projects/:projectId/features",
  "/projects/:projectId/features/:featureId",
  "/projects/:projectId/features/:featureId/testing",
  "/projects/:projectId/features/:featureId/events",
  "/projects/:projectId/features/:featureId/action-items",
  "/projects/:projectId/features/:featureId/model-config",
  "/projects/:projectId/features/:featureId/job-model-overrides",
  "/projects/:projectId/features/:featureId/model-secrets",
  "/projects/:projectId/tests",
  "/projects/:projectId/tests/:testId",
  "/projects/:projectId/tests/:testId/runs",
  "/projects/:projectId/deploys",
  "/projects/:projectId/deploy",
  "/projects/:projectId/designs",
  "/projects/:projectId/previews",
  "/projects/:projectId/secrets",
  "/projects/:projectId/job-model-overrides",
  // The other two from #56.
  "/projects/:projectId/usage",
  "/projects/:projectId/analytics",
] as const;

/**
 * The doubled paths #56 produced. A 401 here would mean the prefix is being
 * joined onto an already-absolute route path again, i.e. the bug is back even if
 * the "intended" assertions above somehow still pass.
 */
const DOUBLED_PATHS = [
  "/organizations/organizations/:organizationId/usage",
  "/organizations/organizations/:organizationId/analytics",
  "/projects/projects/:projectId/usage",
  "/projects/projects/:projectId/analytics",
] as const;

/**
 * Fills in path parameters. Any uuid works: the point is that the layer
 * *matches*, and authorisation is checked before the id is ever validated, so
 * the substitution only needs to satisfy Express's pattern.
 */
function concretise(path: string): string {
  return path
    .replace(/:organizationId/g, ORG)
    .replace(/:projectId/g, PROJECT)
    .replace(/:[A-Za-z]+/g, ORG);
}

describe("app route wiring (issue #56)", () => {
  const app = createApp({ pool: unqueriedPool });

  it("serves /health without auth", async () => {
    // The one public route, asserted so a blanket 401 elsewhere cannot be read
    // as "every route is correctly wired".
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  for (const route of DOCUMENTED_GET_ROUTES) {
    it(`registers GET ${route}`, async () => {
      const path = concretise(route);
      const res = await request(app).get(path);

      expect(
        res.status,
        `${route} returned ${res.status}${res.status === 404 ? " — not registered at this path" : ""}`,
      ).not.toBe(404);
      // Express's default 404 is HTML `Cannot GET …`; a deliberate 404 from a
      // handler is JSON. Checking both means a route that answers 404 for a
      // legitimate reason is not mistaken for a missing route.
      expect(String(res.text)).not.toContain("Cannot GET");
    });
  }

  for (const path of DOUBLED_PATHS) {
    it(`does not serve the doubled path ${path}`, async () => {
      const res = await request(app).get(concretise(path));
      expect(res.status).toBe(404);
    });
  }
});
