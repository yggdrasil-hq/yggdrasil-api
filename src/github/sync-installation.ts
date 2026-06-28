import { config } from "../config.js";
import {
  fetchInstallation,
  fetchInstallationRepositories,
} from "./github-api.js";
import { GithubInstallationRepository } from "./installation-repository.js";

export async function syncInstallationFromGitHub(
  installations: GithubInstallationRepository,
  githubInstallationId: number,
  installedByUserId: string | null,
): Promise<{ id: string }> {
  const remote = await fetchInstallation(
    githubInstallationId,
    config.github.appId,
    config.github.appPrivateKey,
  );
  const record = await installations.upsertFromGitHub({
    githubInstallationId: remote.id,
    accountType: remote.account.type,
    accountLogin: remote.account.login,
    accountId: remote.account.id,
    installedByUserId,
    suspendedAt: remote.suspended_at ? new Date(remote.suspended_at) : null,
  });

  const repos = await fetchInstallationRepositories(
    githubInstallationId,
    config.github.appId,
    config.github.appPrivateKey,
  );
  await installations.syncRepositories(
    record.id,
    repos.map((repo) => ({ fullName: repo.full_name, githubRepoId: repo.id })),
  );
  await installations.clearProjectAccessWarningsIfReposGranted(record.id);

  return { id: record.id };
}
