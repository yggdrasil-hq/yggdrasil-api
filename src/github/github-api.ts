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

/**
 * Creates or updates a single file in a repo via the Contents API — used to
 * scaffold a project's Helm chart (ADR 003 §12). Chosen over the Git Data
 * API's tree/commit dance because it handles an empty/no-commits-yet repo
 * transparently; the trade-off is one commit per file rather than one
 * atomic commit.
 */
export async function putRepositoryFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  token: string,
): Promise<void> {
  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "yggdrasil-api",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: "main",
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`GitHub API PUT /repos/${owner}/${repo}/contents/${path} failed: ${response.status}`);
  }
}

interface GitTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

interface GitTreeResponse {
  tree: GitTreeEntry[];
  truncated: boolean;
}

interface GitBlobResponse {
  content: string;
  encoding: "base64" | string;
}

/**
 * Fetches every file under dirPrefix (e.g. ".yggdrasil/chart/") on ref,
 * keyed by path relative to dirPrefix — used to read a project's scaffolded
 * Helm chart back out for the Orchestrator (ADR 003 §16-style internal
 * fetch pattern). Returns null if the ref has nothing under dirPrefix
 * (chart never scaffolded, or the repo/ref itself doesn't exist).
 */
export async function fetchRepositoryDirectory(
  owner: string,
  repo: string,
  ref: string,
  dirPrefix: string,
  token: string,
): Promise<Record<string, string> | null> {
  const treeResponse = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "yggdrasil-api",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (treeResponse.status === 404) {
    return null;
  }
  if (!treeResponse.ok) {
    throw new Error(`GitHub API git/trees/${ref} failed: ${treeResponse.status}`);
  }

  const tree = (await treeResponse.json()) as GitTreeResponse;
  const prefix = dirPrefix.endsWith("/") ? dirPrefix : `${dirPrefix}/`;
  const matches = tree.tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix));

  if (matches.length === 0) {
    return null;
  }

  const files: Record<string, string> = {};
  for (const entry of matches) {
    const blobResponse = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${entry.sha}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "yggdrasil-api",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!blobResponse.ok) {
      throw new Error(`GitHub API git/blobs/${entry.sha} failed: ${blobResponse.status}`);
    }
    const blob = (await blobResponse.json()) as GitBlobResponse;
    const relativePath = entry.path.slice(prefix.length);
    files[relativePath] = Buffer.from(blob.content, "base64").toString("utf8");
  }

  return files;
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
