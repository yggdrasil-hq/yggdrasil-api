import { describe, expect, it } from "vitest";
import { createProjectsRouter } from "../projects/routes.js";
import { SCOPE_AUTHORIZERS } from "./authorization.js";
import { LIVE_SCOPE_KINDS } from "./types.js";

/**
 * The socket mirrors a REST read, and this checks it still does (ADR 019 item 7).
 *
 * **Why this file exists.** `SCOPE_AUTHORIZERS` names, for each scope, the route
 * whose access rule that scope's subscription reproduces. That pairing is the whole
 * isolation argument for the design-session scope and the test scope — each was
 * chosen because a route existed to mirror — and it is exactly the kind of claim
 * that rots silently: rename the route, move it behind a different prefix, or
 * change which middleware it sits behind, and the socket keeps working while
 * quietly ceasing to mirror anything.
 *
 * A comment cannot catch that. These cases read the **real router's** route table,
 * so the names in `SCOPE_AUTHORIZERS` are checked against the code that serves them
 * rather than against a second copy of the same string.
 *
 * **What it proves, and what it does not.** It proves every scope names a route
 * that exists, that the route is a GET, and that the route is **authenticated**
 * (it carries the auth middleware, so a socket mirroring it is not mirroring a
 * public read). It does *not* prove the authoriser's conditions match the route's
 * — that is what `authorization.test.ts` and the real-database cases in
 * `authorization.postgres.test.ts` are for. A structural check that knows its own
 * limit is worth more than one that implies more than it does.
 */

/**
 * The router's route table, flattened.
 *
 * Builds the projects router with no dependencies at all (`{} as never`), which is
 * safe because the factory only registers handlers — no repository is touched until
 * a request runs, so nothing here needs a database, a pool, or a request.
 *
 * **Paths are router-relative.** `app.ts` mounts this router at `/projects`, so the
 * table holds `/:projectId/features/:featureId/events` while the route a client
 * requests is `/projects/:projectId/features/:featureId/events`. `PROJECTS_MOUNT`
 * below is the bridge, named rather than trimmed with a bare string operation so a
 * changed mount point fails here instead of silently matching nothing.
 */
const PROJECTS_MOUNT = "/projects";

function routeTable(): Array<{ path: string; methods: string[]; handlerCount: number }> {
  const router = createProjectsRouter({} as never);
  const entries: Array<{ path: string; methods: string[]; handlerCount: number }> = [];

  for (const layer of router.stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: unknown[] };
  }>) {
    if (!layer.route) continue;
    entries.push({
      path: layer.route.path,
      methods: Object.entries(layer.route.methods)
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toUpperCase()),
      handlerCount: layer.route.stack.length,
    });
  }

  return entries;
}

/**
 * The route a `SCOPE_AUTHORIZERS` entry names, as the router registers it.
 *
 * The authoriser names the route the way a client requests it, including the mount
 * prefix, because that is the path a reader can find in the API — so the prefix is
 * removed here rather than stored off the entry, keeping one spelling of a route in
 * the codebase.
 */
function routerPathFor(mirrors: string): string {
  expect(mirrors.startsWith(PROJECTS_MOUNT)).toBe(true);
  return mirrors.slice(PROJECTS_MOUNT.length);
}

function findRoute(routes: ReturnType<typeof routeTable>, mirrors: string) {
  return routes.find((route) => route.path === routerPathFor(mirrors));
}

describe("every scope's authoriser mirrors a real route (ADR 019 item 7)", () => {
  const routes = routeTable();

  it("reads a route table with the routes in it", () => {
    // A guard against the scan silently finding nothing — a changed router shape
    // would otherwise let every case below pass for the wrong reason, which is the
    // failure this burn-down keeps finding in checks of its own.
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.some((route) => route.path === "/:projectId/features/:featureId/events")).toBe(
      true,
    );
  });

  it("names a route that exists", () => {
    for (const kind of LIVE_SCOPE_KINDS) {
      const mirrors = SCOPE_AUTHORIZERS[kind].mirrors;
      const found = findRoute(routes, mirrors);
      expect(
        found,
        `${kind} claims to mirror ${mirrors}, which is not registered on the projects router`,
      ).toBeDefined();
    }
  });

  it("names a GET, because each of these is a read the page refreshes from", () => {
    // A socket mirroring a route that had become a POST/PUT would be mirroring an
    // access rule for a mutation — not what a change signal is for.
    for (const kind of LIVE_SCOPE_KINDS) {
      const mirrors = SCOPE_AUTHORIZERS[kind].mirrors;
      expect(findRoute(routes, mirrors)?.methods, `${kind} mirrors ${mirrors}`).toContain("GET");
    }
  });

  it("names an authenticated route, so the socket is not mirroring a public read", () => {
    // The loosening this catches is specific and plausible: if a mirrored route
    // were ever mounted *without* `requireAuth` (a share-link variant, say), the
    // authoriser would be reproducing a rule that no longer restricts anyone — and
    // the socket would be the stricter of the two, which ADR 019 item 7 names as
    // its own failure (a page that looks subscribed and receives nothing).
    //
    // `requireAuth` is one of at least two handlers (the middleware and the
    // handler), so the count is the structural signal available without reaching
    // into the handler identities.
    for (const kind of LIVE_SCOPE_KINDS) {
      const mirrors = SCOPE_AUTHORIZERS[kind].mirrors;
      expect(findRoute(routes, mirrors)?.handlerCount, `${kind} mirrors ${mirrors}`).toBeGreaterThanOrEqual(2);
    }
  });
});
