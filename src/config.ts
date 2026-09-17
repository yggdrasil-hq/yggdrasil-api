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
