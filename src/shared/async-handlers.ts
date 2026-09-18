/**
 * Issue #45: make a rejected promise in a route handler reach the error
 * middleware instead of hanging the request.
 *
 * Express 4 does not inspect what a handler returns. An `async` handler that
 * throws produces an unhandled rejection and **the request never gets a
 * response** — the client waits for its own timeout, the error middleware in
 * `app.ts` is never reached (nothing calls `next`), and the promise is reported
 * only as an unhandled rejection somewhere in the process's log. Behind
 * `deploy/`'s nginx that is a connection held open until `proxy_read_timeout`
 * (3600s for the API routes).
 *
 * This is not hypothetical: it was found by a test that deliberately made a
 * repository throw an unrelated unique violation, and that test hung for 5s and
 * was reported as an unhandled rejection. Every route in this codebase is an
 * `async` handler and nearly all of them `await` a repository or the
 * Orchestrator, so any thrown error — a dropped connection, a `pg`
 * type-inference failure, a constraint violation — became a hung request rather
 * than a 500.
 *
 * **Why a patch rather than a wrapper at each call site.** There are several
 * hundred `router.METHOD(...)` calls across this codebase, and an `asyncHandler()`
 * applied at each one is a rule someone will eventually forget — after which the
 * failure mode is silent. Patching Express's own registration means a handler is
 * wrapped because it was registered, not because its author remembered. (The
 * same idiom as the `express-async-errors` package, inlined: one small module
 * beats a dependency whose whole job is these twenty lines, and this way the
 * behaviour is documented next to the reason it exists.)
 *
 * **Why not upgrade to Express 5**, which handles this natively: that is a
 * major-version migration, not a bug fix, and it belongs in its own change with
 * its own review — see the issue.
 *
 * Imported for its side effect by `app.ts` **before** any router module, so the
 * patch is in place before any `Router` is constructed. Express copies `get`/
 * `post`/… onto each router instance from the shared `Router.prototype`, so
 * patching the prototype once covers every router created afterwards.
 */

import { createRequire } from "node:module";

// This package is ESM (`"type": "module"`), so a bare `require` does not exist —
// it throws at runtime. Worth knowing when reading this module's tests: vitest
// provides a `require` shim, so a bare `require` here passes the suite and then
// breaks the running API with "require is not defined in ES module scope".
// `createRequire` is what works in both.
const require = createRequire(import.meta.url);

/**
 * Express's router: `module.exports` *is* the prototype its instances are given
 * (`setPrototypeOf(routerInstance, proto)`), so `use` lives on the function
 * itself rather than on `Router.prototype`. The HTTP verbs are patched on
 * `Route.prototype` instead — see below — because Router's own
 * `proto.get(path, …)` delegates to `this.route(path)` and hands the handlers on.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const Router = require("express/lib/router") as {
  use?: (...args: unknown[]) => unknown;
};
const Route = require("express/lib/router/route") as {
  prototype: Record<string, unknown>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

/** Every method Express generates a registration function for (`methods.concat('all')`). */
const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "all",
] as const;

/**
 * Stamped on a handler once wrapped, so the patch is idempotent.
 *
 * Without this, a handler registered on two routers — or a test that builds an
 * app twice in one process — would be wrapped twice: harmless for behaviour, but
 * it makes the wrapper's cost proportional to how many times a module has been
 * imported, which is the kind of thing that is baffling to debug later.
 */
const WRAPPED = Symbol.for("yggdrasil.asyncHandlerWrapped");

type NextFunction = (error?: unknown) => void;

/**
 * A handler that takes four arguments is Express's error middleware — it is
 * called with `(err, req, res, next)` and is *supposed* to swallow errors.
 * Wrapping one would change its arity to three, at which point Express stops
 * recognising it as an error handler at all and starts calling it as ordinary
 * middleware. So arity is the signal, and it is checked before anything else.
 */
function isErrorMiddleware(handler: (...args: never[]) => unknown): boolean {
  return handler.length >= 4;
}

function wrap(handler: (...args: never[]) => unknown) {
  const existing = (handler as unknown as Record<symbol, unknown>)[WRAPPED];
  if (existing) return existing;

  const wrapped = function (
    req: unknown,
    res: unknown,
    next: NextFunction,
  ): void {
    try {
      const result = handler(req as never, res as never, next as never);
      // Only a thenable needs watching. A synchronous throw is already caught
      // by Express itself, but checking both keeps the two cases in one place
      // and costs nothing.
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        (result as PromiseLike<unknown>).then(undefined, next);
      }
    } catch (error) {
      next(error);
    }
  };

  Object.defineProperty(wrapped, WRAPPED, { value: wrapped });
  return wrapped;
}

function wrapHandlers(args: unknown[]): unknown[] {
  return args.map((arg) =>
    typeof arg === "function" && !isErrorMiddleware(arg as (...a: never[]) => unknown)
      ? wrap(arg as (...a: never[]) => unknown)
      : arg,
  );
}

for (const method of HTTP_METHODS) {
  // `Route.prototype[method]` is what actually receives the handlers: Router's
  // own `proto[method]` delegates to `this.route(path)` and then applies the
  // handlers to that Route. Patching here is what catches both
  // `router.get(path, handler)` and `router.route(path).get(handler)`.
  const original = Route.prototype[method] as (...args: unknown[]) => unknown;
  if (typeof original !== "function") continue;

  Route.prototype[method] = function (this: unknown, ...args: unknown[]) {
    return original.apply(this, wrapHandlers(args));
  };
}

/**
 * `router.use(handler)` does not go through a Route, so it needs its own patch.
 *
 * Its arguments may be `(handler)`, `(path, handler)`, `(router)`, or
 * `(path, router, handler)` — a mounted `Router` is a function too, and wrapping
 * one would replace it with a plain handler and break the mount. Thus the
 * `isRouter` check: Express marks router instances with `handle` + `set`.
 */
type PossiblyRouter = { handle?: unknown; set?: unknown };

function isRouter(value: unknown): boolean {
  if (typeof value !== "function") return false;
  const candidate = value as PossiblyRouter;
  return typeof candidate.handle === "function" && typeof candidate.set === "function";
}

const originalUse = Router.use as (...args: unknown[]) => unknown;
if (typeof originalUse === "function") {
  Router.use = function (this: unknown, ...args: unknown[]) {
    return originalUse.apply(
      this,
      args.map((arg) =>
        typeof arg === "function" &&
        !isRouter(arg) &&
        !isErrorMiddleware(arg as (...a: never[]) => unknown)
          ? wrap(arg as (...a: never[]) => unknown)
          : arg,
      ),
    );
  };
}

export {};
