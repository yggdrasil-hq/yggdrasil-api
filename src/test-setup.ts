// Runs before any test file's own imports evaluate `config.ts` (which reads
// these at module-load time) — needed so secrets-encryption tests don't have
// to depend on the real dev .env.
process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.INTERNAL_API_TOKEN ??= "test-internal-api-token";

/*
 * Issue #45's patch, loaded here so it is in force for **every** test that
 * exercises a route.
 *
 * `app.ts` imports this for its side effect, so a thrown error inside an async
 * handler reaches the error middleware in production. But 26 test files build a
 * bare `express()` app and mount a router directly — they never import `app.ts`,
 * so they never loaded the patch. The consequence is not a subtle difference: a
 * route handler that throws produced an **unhandled rejection and a hung
 * request**, timing the test out at its 5s limit and reporting the real cause only
 * as an "Unhandled Error" in vitest's epilogue.
 *
 * That is a test environment behaving differently from the server it is testing,
 * which is the same class as #56 (a route test mounting a router the way `app.ts`
 * does not, so it passed while the app 404'd). Loading it centrally makes the two
 * agree: a throw becomes the 500 it would be at runtime, in the place it happens,
 * with its message attached.
 *
 * Idempotent — `async-handlers.ts` stamps each wrapped handler — so a test that
 * also imports it explicitly (as `shared/async-handlers.test.ts` does, to assert
 * the patch itself) is unaffected.
 */
import "./shared/async-handlers.js";
