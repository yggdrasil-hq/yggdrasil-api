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
  sessionTtl: {
    defaultMs: 24 * 60 * 60 * 1000,
    rememberMs: 30 * 24 * 60 * 60 * 1000,
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
