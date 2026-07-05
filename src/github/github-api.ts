import { createGitHubAppJwt } from "./app-jwt.js";

const GITHUB_API = "https://api.github.com";

function normalizePrivateKey(privateKeyPem: string): string {
  return privateKeyPem.replace(/\\n/g, "\n");
}

export interface GitHubInstallationAccount {
  id: number;
  login: string;
  type: "Organization" | "User";
}

export interface GitHubInstallationResponse {
  id: number;
  account: GitHubInstallationAccount;
  suspended_at: string | null;
}

export interface GitHubInstallationRepo {
  id: number;
  full_name: string;
}

async function githubAppFetch<T>(
  path: string,
  appId: string,
  privateKeyPem: string,
  init?: RequestInit,
): Promise<T> {
  const jwt = createGitHubAppJwt(appId, privateKeyPem);
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "User-Agent": "yggdrasil-api",
      "X-GitHub-Api-Version": "2022-11-28",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${path} failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchInstallation(
  installationId: number,
  appId: string,
  privateKeyPem: string,
): Promise<GitHubInstallationResponse> {
  return githubAppFetch<GitHubInstallationResponse>(
    `/app/installations/${installationId}`,
    appId,
    privateKeyPem,
  );
}

export async function fetchInstallationRepositories(
  installationId: number,
  appId: string,
  privateKeyPem: string,
): Promise<GitHubInstallationRepo[]> {
  const { token } = await mintInstallationAccessToken(installationId, appId, privateKeyPem);
  const repos: GitHubInstallationRepo[] = [];
  let page = 1;

  while (true) {
    const response = await fetch(
      `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "yggdrasil-api",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      throw new Error(`GitHub API /installation/repositories failed: ${response.status}`);
    }

    const batch = (await response.json()) as { repositories: GitHubInstallationRepo[] };
    repos.push(...batch.repositories);
    if (batch.repositories.length < 100) {
      break;
    }
    page += 1;
  }

  return repos;
}

export async function mintInstallationAccessToken(
  installationId: number,
  appId: string,
  privateKeyPem: string,
): Promise<{ token: string; expiresAt: Date }> {
  const jwt = createGitHubAppJwt(appId, normalizePrivateKey(privateKeyPem));
  const response = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "User-Agent": "yggdrasil-api",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to mint installation token: ${response.status}`);
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: new Date(data.expires_at) };
}
