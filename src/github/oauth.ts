import { randomBytes } from "node:crypto";
import type pg from "pg";

export type OAuthIntent = "login" | "signup" | "link" | "upgrade";

export interface OAuthStateRecord {
  state: string;
  intent: OAuthIntent;
  userId: string | null;
  returnTo: string | null;
  scopes: string[];
}

export class OAuthStateRepository {
  constructor(private readonly db: pg.Pool) {}

  async create(input: {
    intent: OAuthIntent;
    userId?: string | null;
    returnTo?: string | null;
    scopes: string[];
  }): Promise<OAuthStateRecord> {
    const state = randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await this.db.query(
      `INSERT INTO oauth_states (state, intent, user_id, return_to, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        state,
        input.intent,
        input.userId ?? null,
        input.returnTo ?? null,
        input.scopes,
        expiresAt,
      ],
    );
    return {
      state,
      intent: input.intent,
      userId: input.userId ?? null,
      returnTo: input.returnTo ?? null,
      scopes: input.scopes,
    };
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    const result = await this.db.query<{
      state: string;
      intent: OAuthIntent;
      user_id: string | null;
      return_to: string | null;
      scopes: string[];
    }>(
      `DELETE FROM oauth_states
       WHERE state = $1 AND expires_at > NOW()
       RETURNING state, intent, user_id, return_to, scopes`,
      [state],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      state: row.state,
      intent: row.intent,
      userId: row.user_id,
      returnTo: row.return_to,
      scopes: row.scopes,
    };
  }
}

export const GITHUB_READ_USER_SCOPE = "read:user";
export const GITHUB_REPO_SCOPE = "repo";

export function scopesForIntent(intent: OAuthIntent): string[] {
  if (intent === "upgrade") {
    return [GITHUB_READ_USER_SCOPE, GITHUB_REPO_SCOPE];
  }
  return [GITHUB_READ_USER_SCOPE];
}

interface GitHubTokenResponse {
  access_token: string;
  scope: string;
  token_type: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

export async function exchangeGitHubCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; scopes: string[] }> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error("GitHub token exchange failed");
  }

  const data = (await response.json()) as GitHubTokenResponse & { error?: string };
  if (data.error || !data.access_token) {
    throw new Error(data.error ?? "GitHub token exchange failed");
  }

  const scopes = data.scope ? data.scope.split(",").map((s) => s.trim()).filter(Boolean) : [];
  return { accessToken: data.access_token, scopes };
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUserResponse> {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "yggdrasil-api",
    },
  });

  if (!response.ok) {
    throw new Error("Failed to fetch GitHub user");
  }

  return response.json() as Promise<GitHubUserResponse>;
}

export function buildGitHubAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scopes.join(" "),
    state: input.state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}
