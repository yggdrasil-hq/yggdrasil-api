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
  appPublicUrl: process.env.APP_PUBLIC_URL ?? "http://localhost:8080/app",
  apiPublicUrl: process.env.API_PUBLIC_URL ?? "http://localhost:8080/api",
  github: {
    clientId: process.env.GITHUB_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  },
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

export function isGitHubOAuthConfigured(): boolean {
  return Boolean(config.github.clientId && config.github.clientSecret);
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
