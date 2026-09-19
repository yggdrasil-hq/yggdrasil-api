import { parseGoDurationMs } from "./shared/duration.js";

/**
 * Issue #92: the bound on one unanswered grill question, as the **API's mirror**
 * of the Orchestrator's own `GRILL_REPLY_TIMEOUT`.
 *
 * **Why the API holds a copy at all.** The bound is owned by the Orchestrator
 * (`orchestrator/internal/worker/replytimeout.go`, `defaultReplyTimeout`) and
 * enforced by it when `ask_user` goes unanswered (issue #82). A surface that says
 * "expires in 18h" needs the same number, and there is no endpoint, no shared
 * table and no shared `.env` between the two services — `deploy/
 * docker-compose.dev.yml` gives each its own `env_file`. So the choice is a second
 * copy here or no countdown at all.
 *
 * **Why a copy is acceptable here, given this burn-down's history with drift.**
 * Every "declaration disagreeing with reality" bug found in this work (#75, #86,
 * and the four field-drops in #38/#59/#73/#88) shared one shape: two records of
 * one fact, and nothing that fails when they diverge. So this copy ships with the
 * three things that keep such a pair honest rather than merely documented:
 *
 * 1. **The same variable name and the same syntax.** `GRILL_REPLY_TIMEOUT=24h`
 *    parses identically on both sides (`parseGoDurationMs` implements Go's
 *    grammar deliberately), so the value an operator writes for the Orchestrator
 *    can be pasted here verbatim. A different syntax or name would have made the
 *    duplicate practically un-settable, which is the version of this that *is*
 *    indefensible.
 * 2. **The same default, pinned by a test.** `config.test.ts` asserts the shipped
 *    default equals `DEFAULT_GRILL_REPLY_TIMEOUT_MS` and that the constant carries
 *    the Orchestrator's value in its comment, following the precedent
 *    `capabilities.DefaultReportInterval` set in #63 (an interval in one repo
 *    asserted against the other repo's trust window, declared locally because
 *    neither side's suite can see the other). A change to either default has to be
 *    a deliberate change here too.
 * 3. **Provenance on the wire.** The read reports `timeoutSource`, so a client can
 *    tell a configured value from the shipped default and is never told an
 *    assumption is a statement of fact.
 *
 * **What none of that fixes, stated rather than hidden.** An operator who raises
 * the bound on the Orchestrator only will see the API still report 24h, because
 * this process cannot read the other's environment. `timeoutSource: "default"` is
 * that client's signal to hedge or omit the countdown; the API cannot detect the
 * disagreement itself. The mirror note on the Orchestrator side is filed
 * separately, since this repo does not own that file.
 */
export const DEFAULT_GRILL_REPLY_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * The variable the Orchestrator reads (`orchestrator/cmd/server/main.go`,
 * `resolveReplyTimeout`). Spelled once here because two spellings of an env var
 * name is its own small drift.
 */
export const GRILL_REPLY_TIMEOUT_ENV = "GRILL_REPLY_TIMEOUT";

/**
 * Turns the raw environment value into the bound this service reports, and says
 * where it came from.
 *
 * Split out of the `config` object (and exported) so the *configured* path is
 * reachable from a test. `config` is built at module load from `process.env`, so
 * anything only reachable through it can be observed in its unset state and no
 * other — which would leave the interesting half, what a given string resolves to,
 * unverified.
 *
 * Non-positive is treated as unset, mirroring `replyTimeout()`, which returns the
 * default for any value `<= 0`. A zero or negative bound describes a question that
 * is already expired, so it is not something this can honestly display, and the
 * Orchestrator does not honour it either — the two sides have to agree on what a
 * value *means*, or the mirror is worse than absent.
 */
export function resolveGrillReplyTimeout(raw: string | undefined): {
  timeoutMs: number;
  source: "configured" | "default";
} {
  const parsed = parseGoDurationMs(raw ?? "");
  if (parsed === null || parsed <= 0) {
    return { timeoutMs: DEFAULT_GRILL_REPLY_TIMEOUT_MS, source: "default" };
  }
  return { timeoutMs: parsed, source: "configured" };
}

/**
 * Parses `SESSION_MAX_BYTES`, where **zero is a value and not an absence**.
 *
 * ADR 032 item 4 requires a non-positive cap to mean "reclaim everything", and the
 * `Number(env) || default` idiom the sibling config blocks use cannot express that:
 * `0 || 5_000_000` is the default, so the instruction would be silently replaced by
 * the thing it was meant to switch off. Hence an explicit parser rather than the
 * idiom — and exported, following `resolveGrillReplyTimeout`, so the interesting half
 * (what a given string resolves to) is testable without constructing the module.
 *
 * An unset, empty or unparseable value is the default, which is the one case that
 * *should* fall back: a typo must not switch collection off. A negative value is
 * clamped to zero rather than kept, so `-1` and `0` cannot mean different things to
 * the upload path and the sweep.
 */
export function sessionMaxBytesFrom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_SESSION_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_MAX_BYTES;
  return Math.max(0, Math.floor(parsed));
}

/**
 * The default cap on one stored session, matching the Orchestrator's own
 * `DefaultSessionMaxBytes`.
 *
 * A cross-repo constant that cannot be checked by either side's tests, exactly like
 * `DEFAULT_GRILL_REPLY_TIMEOUT_MS`: if the two disagree, the API silently declines
 * artifacts the Orchestrator considered within policy, and the only symptom is a
 * 202 in the Orchestrator's log. Stated as "the other service's value" rather than
 * chosen independently so a reader knows the coupling is deliberate.
 */
export const DEFAULT_SESSION_MAX_BYTES = 5_000_000;

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: process.env.DATABASE_URL ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret-change-me",
  cookieName: "yggdrasil_session",
  // Cookie `Domain` attribute. Unset in dev, where web and api share an
  // origin via nginx path routing (docs/conventions/deploy.md) so the
  // cookie's default (exact-host) scope already covers both. Required in a
  // subdomain deploy (e.g. ".example.com") — otherwise a cookie set by
  // API_PUBLIC_URL's host (api.example.com) is invisible to requests made to
  // APP_PUBLIC_URL's host (app.example.com), including the Next.js
  // middleware's server-side session check, which then redirects back to
  // /login no matter how many times the user completes GitHub OAuth.
  sessionCookieDomain: process.env.SESSION_COOKIE_DOMAIN || undefined,
  appPublicUrl: process.env.APP_PUBLIC_URL ?? "http://localhost:8080/app",
  apiPublicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:8080/api",
  // The only browser origin allowed to make credentialed cross-origin
  // requests. Derived from APP_PUBLIC_URL rather than a separate env var so
  // it can't drift — deploy/docker-compose.prod.yml already sets
  // APP_PUBLIC_URL to the real https://${APP_HOST} in a subdomain deploy. In
  // dev, web and api share an origin via nginx path routing
  // (docs/conventions/deploy.md), so this only matters in prod-shaped envs.
  corsOrigin: new URL(process.env.APP_PUBLIC_URL ?? "http://localhost:8080/app").origin,
  // Must match the Orchestrator's own APPS_BASE_DOMAIN (orchestrator/cmd/server/main.go)
  // — both sides independently derive the same <project-slug>.apps.<domain>
  // primary-deployment URL (ADR 003 §15, docs/conventions/deploy.md): the
  // Orchestrator to build the real k8s Ingress host, the API to hand the
  // Web app a link to it. Not sourced from the Orchestrator to avoid a
  // runtime dependency between two otherwise-decoupled services.
  appsBaseDomain: process.env.APPS_BASE_DOMAIN ?? "yggdrasil.local",
  // Set only for local dev, where the bundled k3s cluster's ingress is
  // published on a non-standard host port (deploy/docker-compose.dev.yml's
  // DEV_APPS_HTTPS_PORT, default 8443) instead of the real 443 a
  // self-hosted/managed install's ingress/LB would own. Empty in
  // prod-shaped envs, so the deploy link is a normal port-less https:// URL
  // there.
  appsHttpsPort: process.env.APPS_HTTPS_PORT ?? "",
  github: {
    clientId: process.env.GITHUB_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    appId: process.env.GITHUB_APP_ID ?? "",
    appPrivateKey: process.env.GITHUB_APP_PRIVATE_KEY ?? "",
    appWebhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET ?? "",
    appSlug: process.env.GITHUB_APP_SLUG ?? "",
  },
  secretsEncryptionKey: process.env.SECRETS_ENCRYPTION_KEY ?? "",
  internalApiToken: process.env.INTERNAL_API_TOKEN ?? "",
  /**
   * ADR 026's test-run scheduler, which the API process runs in-process (see
   * `scheduling/scheduler.ts` for why it is not its own service).
   *
   * `intervalMs` is the resolution of every schedule — a test cannot fire
   * sooner than one tick after its window opens — so it is deliberately well
   * under the product's one-hour minimum test interval, and its minimum is
   * floored so a bad env var cannot turn the ticker into a busy loop against
   * the database. `enabled` exists so a developer can run the API without
   * background work; it is on by default because a scheduler that has to be
   * switched on is a scheduler that silently does nothing after a fresh
   * install.
   */
  scheduler: {
    enabled: process.env.TEST_SCHEDULER_ENABLED !== "false",
    intervalMs: Math.max(
      1_000,
      Number(process.env.TEST_SCHEDULER_INTERVAL_MS) || 60_000,
    ),
  },
  /**
   * ADR 019: the live job-event relay (the Web app's WebSocket).
   *
   * `enabled` is a kill switch, on by default. The relay is an *accelerator*
   * over the REST read the Web app already polls, so switching it off degrades
   * to the pre-existing behaviour rather than breaking anything — which is
   * exactly the property that makes a toggle worth having: if the socket path
   * misbehaves in a live install it can be turned off without a rollback. It
   * defaults on for the same reason the scheduler and recording sweep do: a
   * relay that must be switched on is one that silently does nothing after a
   * fresh install.
   *
   * `retryDelayMs` is floored so a bad env var cannot turn a failing Postgres
   * connection into a tight reconnect loop.
   *
   * The three limits below are issue #24 (ADR 019 follow-up 4). They are
   * configurable rather than constants because the right ceiling depends on the
   * install — a self-hosted single-user deployment and a shared one have
   * different ideas of "abusive" — and because the response to a limit that
   * fires wrongly must be to raise it without a redeploy of the code. Each is
   * floored for the same reason the numbers above are: a limit of 0 (or a NaN
   * from an unparseable value) would close every socket on its first frame,
   * which is an outage caused by a guard rather than prevented by it.
   *
   * The defaults and the reasoning behind their size are documented on
   * `FrameBudget` in `live/limits.ts` — deliberately there rather than here, so
   * the number and the argument for it cannot drift apart.
   */
  live: {
    enabled: process.env.LIVE_RELAY_ENABLED !== "false",
    retryDelayMs: Math.max(
      1_000,
      Number(process.env.LIVE_RELAY_RETRY_MS) || 5_000,
    ),
    /** Sustained outbound frames per socket, per second. */
    framesPerSecond: Math.max(
      1,
      Math.floor(Number(process.env.LIVE_FRAMES_PER_SECOND)) || 60,
    ),
    /** Frames a socket may send back-to-back before the sustained rate applies. */
    frameBurst: Math.max(
      1,
      Math.floor(Number(process.env.LIVE_FRAME_BURST)) || 120,
    ),
    /**
     * Total delta text bytes relayed for one job before its deltas stop being
     * relayed (issue #24). `0` disables the ceiling, matching
     * `RECORDING_MAX_BYTES`' convention that 0 is a meaningful "off" rather than
     * "unset" — see `recordRelayedDeltaBytes` in `jobs/repository.ts` for what
     * happens at the boundary and why nothing is lost when it is reached.
     */
    deltaBytesPerJob: Math.max(
      0,
      Math.floor(Number(process.env.LIVE_DELTA_BYTES_PER_JOB)) || 8_000_000,
    ),
  },
  sessionTtl: {
    defaultMs: 24 * 60 * 60 * 1000,
    rememberMs: 30 * 24 * 60 * 60 * 1000,
  },
  /**
   * ADR 029: test-run screen recordings.
   *
   * `maxBytes` is the single most important number here. A recording is orders
   * of magnitude larger than the JSON report it accompanies, and ADR 029 stores
   * the bytes in Postgres (no S3 client exists in this codebase — see
   * `recordings/repository.ts`), so an unbounded upload is a way to exhaust the
   * database. 25 MB comfortably covers a several-minute Playwright session of a
   * UI test at a sane viewport; a run that exceeds it is *skipped*, not failed,
   * and the fact that it was skipped is what the report records.
   *
   * `retentionDays` is the other half of that bound. Video accrues far faster
   * than reports do, so "keep it forever" is only viable for a demo install;
   * 30 days keeps a month of history, which is the window in which a failed
   * run's recording is actually useful for diagnosis. Expiry does not delete the
   * row — it tombstones it (see `recordings/repository.ts`), so the UI can still
   * say a recording existed and was reclaimed.
   *
   * `sweepIntervalMs` is floored like the scheduler's, so a bad env var cannot
   * turn the sweep into a busy loop. `enabled` follows the scheduler's
   * reasoning: a background job that has to be switched on is one that silently
   * does nothing after a fresh install.
   */
  recordings: {
    enabled: process.env.RECORDINGS_ENABLED !== "false",
    maxBytes: Math.max(0, Number(process.env.RECORDING_MAX_BYTES) || 25_000_000),
    retentionDays: Math.max(1, Number(process.env.RECORDING_RETENTION_DAYS) || 30),
    sweepIntervalMs: Math.max(
      1_000,
      Number(process.env.RECORDING_SWEEP_INTERVAL_MS) || 15 * 60_000,
    ),
  },
  /**
   * ADR 032 item 1: Pi session files for `spec_grill` runs.
   *
   * A **separate block from `recordings`** rather than shared values, for the reason
   * `screenshots` gives: the two artifacts are three orders of magnitude apart in
   * size and have entirely different rate profiles, so a project may reasonably want
   * a different policy for each, and shared config would be the thing preventing it.
   * `retentionDays`' default *agrees* with recordings' because ADR 032 item 4 says
   * the window is the same by default — that is a default, not a shared source.
   *
   * The three numbers:
   *
   * - `maxBytes` bounds one session. **Deliberately not inherited from
   *   `RECORDING_MAX_BYTES`**: a session is text and Pi appends tool results
   *   verbatim, so a long grill is megabytes against a video's tens of megabytes.
   *   Borrowing the recording's 25 MB would advertise a ceiling no session reaches
   *   and make the path that enforces it untestable in practice. 5 MB matches the
   *   Orchestrator's own `DefaultSessionMaxBytes` — the two halves must agree about
   *   the number or the API would silently decline artifacts the Orchestrator
   *   considered fine, which is why this default is stated as "the same value as the
   *   other service" rather than chosen freely.
   *
   *   **A value of zero is an instruction, not an absence** — ADR 032 item 4's
   *   "if it is set to zero it must mean 'reclaim everything', not 'keep
   *   forever'". It is parsed by `sessionMaxBytesFrom` rather than by the
   *   `Number(env) || default` idiom the sibling blocks use, because that idiom
   *   cannot express zero at all: `0 || 25_000_000` is the default, so an operator
   *   writing `SESSION_MAX_BYTES=0` would silently get 5 MB. That is a real trap and
   *   not a hypothetical — `RECORDING_MAX_BYTES=0` is unreachable the same way,
   *   which is filed separately rather than changed here, since altering the
   *   recording path's parsing is not this change's business.
   *
   * - `retentionDays` is the other half of the bound, and a session is the more
   *   sensitive artifact: it holds the full conversation including anything the
   *   transcript redacts, so this window is a data-retention decision and not only a
   *   storage one (ADR 032's trade-offs). 30 days matches recordings'.
   *
   * - `sweepIntervalMs` is floored so a bad env var cannot turn the sweep into a busy
   *   loop, and `enabled` follows the scheduler's reasoning: a background job that
   *   has to be switched on is one that silently does nothing after a fresh install.
   */
  sessions: {
    enabled: process.env.SESSIONS_ENABLED !== "false",
    maxBytes: sessionMaxBytesFrom(process.env.SESSION_MAX_BYTES),
    retentionDays: Math.max(
      1,
      Math.floor(Number(process.env.SESSION_RETENTION_DAYS)) || 30,
    ),
    sweepIntervalMs: Math.max(
      1_000,
      Math.floor(Number(process.env.SESSION_SWEEP_INTERVAL_MS)) || 15 * 60_000,
    ),
  },
  /**
   * Issue #22: per-step test-run screenshots.
   *
   * Deliberately a separate block from `recordings` rather than shared values,
   * even though they annotate the same run and the defaults agree. Screenshots
   * are three orders of magnitude smaller (a few hundred kB against tens of MB),
   * so a project may reasonably keep them longer than the video — and the moment
   * that is true, shared config would be the thing preventing it. The defaults
   * agree so an operator sees one policy unless they choose otherwise.
   *
   * `maxBytes` bounds one file; `maxPerJob` bounds a run. Both are needed, and
   * the second is not implied by the first: the number of steps is decided by
   * the `##` headings in the project's own test markdown, so a spec with
   * thousands of headings would be thousands of files. Bounded per file is not
   * bounded per run.
   *
   * `contentTypes` is the accepted format whitelist and is deliberately not
   * env-configurable: it is a security boundary (an SVG is a document that can
   * carry script, and these bytes are served inline from our own origin), not a
   * tuning knob. It lives here so the route's `express.raw` type filter, the
   * rejection message and the table's CHECK constraint all read from one list.
   */
  screenshots: {
    enabled: process.env.SCREENSHOTS_ENABLED !== "false",
    contentTypes: ["image/png", "image/jpeg", "image/webp"],
    maxBytes: Math.max(0, Math.floor(Number(process.env.SCREENSHOT_MAX_BYTES)) || 2_000_000),
    maxPerJob: Math.max(0, Math.floor(Number(process.env.SCREENSHOT_MAX_PER_JOB)) || 50),
    retentionDays: Math.max(
      1,
      Math.floor(Number(process.env.SCREENSHOT_RETENTION_DAYS)) || 30,
    ),
    sweepIntervalMs: Math.max(
      1_000,
      Math.floor(Number(process.env.SCREENSHOT_SWEEP_INTERVAL_MS)) || 15 * 60_000,
    ),
  },
  /**
   * Issue #92: the bound on one unanswered grill question, mirrored from the
   * Orchestrator. See `DEFAULT_GRILL_REPLY_TIMEOUT_MS` for the decision, why a
   * copy is tolerable, and what it cannot fix.
   *
   * Parsed with `parseGoDurationMs` rather than `Number`, and **non-positive is
   * treated as unset** — both mirroring `resolveReplyTimeout` exactly, which passes
   * zero (unset, unparseable or non-positive) through as "use the default". A bound
   * of zero or less would describe a question that is already expired, so it is not
   * a value this can meaningfully display, and the Orchestrator does not honour it
   * either. Mirroring that rule is the point: the two must agree on what a given
   * value *means*, or this copy is worse than absent.
   *
   * An unparseable value therefore falls back silently rather than warning. That is
   * deliberate and matches the Orchestrator's own choice (a typo must not remove
   * the bound), and the fallback is not invisible — it surfaces as
   * `timeoutSource: "default"` on every read, which is a better signal than a
   * start-up line nobody is looking at.
   */
  grills: (() => {
    const resolved = resolveGrillReplyTimeout(process.env[GRILL_REPLY_TIMEOUT_ENV]);
    return {
      replyTimeoutMs: resolved.timeoutMs,
      replyTimeoutSource: resolved.source,
    };
  })(),
  /**
   * Issue #30: where binary artifacts are stored.
   *
   * These six variables have been set by both compose files since the dev stack
   * was written and read by nothing — the issue calls them "aspirational", and
   * this is what they were aspirational *for*. A recording is orders of magnitude
   * larger than the JSON report beside it, ADR 029 stored the bytes in Postgres
   * because no storage client existed, and the consequence recorded there was a
   * database whose backups had started to contain video.
   *
   * `enabled` is derived rather than read from its own variable, and that is the
   * important decision here: object storage is used when it is *configured*
   * (endpoint, both credentials and a bucket are all present) and not otherwise.
   * A separate switch would allow the two to disagree — on, with no endpoint,
   * which is a config that can only fail at the first upload; or off, with a
   * complete configuration, which is a set of variables that silently does
   * nothing, which is exactly the bug being fixed. Deriving it means "configured"
   * and "used" cannot drift, and `createObjectStorage` returns null rather than
   * throwing when the config is partial, so a half-filled install falls back to
   * Postgres and keeps working.
   *
   * The credentials are read the same way every other secret in this file is —
   * plain `process.env`, never logged — and `S3_FORCE_PATH_STYLE` defaults to
   * true because the bundled service is MinIO, where path style is the norm; an
   * install pointing at AWS S3 sets it to "false" explicitly.
   */
  storage: (() => {
    const endpoint = process.env.S3_ENDPOINT ?? "";
    const accessKeyId = process.env.S3_ACCESS_KEY ?? "";
    const secretAccessKey = process.env.S3_SECRET_KEY ?? "";
    const bucket = process.env.S3_BUCKET ?? "";
    return {
      endpoint,
      accessKeyId,
      secretAccessKey,
      bucket,
      region: process.env.S3_REGION ?? "us-east-1",
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      /**
       * True only when a client can actually be built, i.e. when every field
       * `createObjectStorage` requires is present. Reading it from the same
       * predicate keeps the log line below and the wiring in `app.ts` agreeing
       * about whether storage is on.
       */
      configured: Boolean(endpoint && accessKeyId && secretAccessKey && bucket),
    };
  })(),
  rateLimit: {
    perUsername: { max: 10, windowMs: 15 * 60 * 1000 },
    perIp: { max: 30, windowMs: 15 * 60 * 1000 },
  },
} as const;

export function assertDatabaseUrl(): string {
  return required("DATABASE_URL", config.databaseUrl || undefined);
}

const SECRETS_ENCRYPTION_KEY_BYTES = 32;

/** Validated at the config boundary: a wrong-length key fails AES-256-GCM silently otherwise. */
export function assertSecretsEncryptionKey(): Buffer {
  const raw = required("SECRETS_ENCRYPTION_KEY", config.secretsEncryptionKey || undefined);
  const key = Buffer.from(raw, "base64");
  if (key.length !== SECRETS_ENCRYPTION_KEY_BYTES) {
    throw new Error(
      `SECRETS_ENCRYPTION_KEY must decode to ${SECRETS_ENCRYPTION_KEY_BYTES} bytes (got ${key.length}); generate one with: openssl rand -base64 32`,
    );
  }
  return key;
}

export function isGitHubOAuthConfigured(): boolean {
  return Boolean(config.github.clientId && config.github.clientSecret);
}

export function isGitHubAppConfigured(): boolean {
  return Boolean(
    config.github.appId &&
      config.github.appPrivateKey &&
      config.github.appSlug,
  );
}

/** Build a browser redirect URL under APP_PUBLIC_URL (avoids `new URL` absolute-path pitfall). */
export function appPublicRedirect(
  path: string,
  params?: Record<string, string>,
): string {
  const base = config.appPublicUrl.replace(/\/$/, "");
  const suffix = path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}${suffix}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}
