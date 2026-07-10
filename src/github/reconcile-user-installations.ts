import { config } from "../config.js";
import {
  fetchUserInstallations,
  refreshUserOAuthToken,
  GithubApiUnauthorizedError,
} from "./github-api.js";
import { GithubInstallationRepository } from "./installation-repository.js";
import { GithubTokenRepository } from "./token-repository.js";
import { UserGithubAccessRepository } from "./user-github-access-repository.js";
import { syncInstallationFromGitHub } from "./sync-installation.js";

export type ReconcileUserInstallationsResult =
  | { status: "ok" }
  | { status: "reauth_required" }
  | { status: "soft_fail" };

/**
 * Reconciles a user's GitHub App installations by asking GitHub directly
 * (`GET /user/installations`, their own OAuth token) rather than trusting
 * only webhook-fed local state — installs made outside Yggdrasil's own
 * redirect flow (or before webhooks were configured) never reach us any
 * other way. Upserts into `github_installations` + `user_installation_access`
 * and, for any installation discovered with no synced repos yet, triggers
 * the existing app-level repo sync so the picker isn't left showing an
 * org with zero repos.
 */
export async function reconcileUserInstallations(deps: {
  githubTokens: GithubTokenRepository;
  installations: GithubInstallationRepository;
  userGithubAccess: UserGithubAccessRepository;
  userId: string;
}): Promise<ReconcileUserInstallationsResult> {
  const { githubTokens, installations, userGithubAccess, userId } = deps;

  const token = await githubTokens.get(userId);
  if (!token) {
    return { status: "reauth_required" };
  }

  let accessToken = token.accessToken;
  let remoteInstallations;
  try {
    remoteInstallations = await fetchUserInstallations(accessToken);
  } catch (error) {
    if (!(error instanceof GithubApiUnauthorizedError)) {
      console.error(`reconcileUserInstallations: fetchUserInstallations failed for user ${userId}:`, error);
      return { status: "soft_fail" };
    }
    if (!token.refreshToken) {
      console.error(`reconcileUserInstallations: token expired and no refresh_token for user ${userId}`);
      return { status: "reauth_required" };
    }

    try {
      const refreshed = await refreshUserOAuthToken(
        token.refreshToken,
        config.github.clientId,
        config.github.clientSecret,
      );
      accessToken = refreshed.accessToken;
      await githubTokens.updateAccessToken(userId, refreshed.accessToken, refreshed.refreshToken);
      remoteInstallations = await fetchUserInstallations(accessToken);
    } catch (retryError) {
      if (retryError instanceof GithubApiUnauthorizedError) {
        console.error(`reconcileUserInstallations: refresh_token rejected for user ${userId}:`, retryError);
        return { status: "reauth_required" };
      }
      console.error(`reconcileUserInstallations: retry after refresh failed for user ${userId}:`, retryError);
      return { status: "soft_fail" };
    }
  }

  try {
    for (const remote of remoteInstallations) {
      const record = await installations.upsertFromGitHub({
        githubInstallationId: remote.id,
        accountType: remote.account.type,
        accountLogin: remote.account.login,
        accountId: remote.account.id,
        suspendedAt: remote.suspended_at ? new Date(remote.suspended_at) : null,
      });
      await userGithubAccess.upsertAccess(userId, record.id);

      const hasRepos = await installations.hasAnyRepositories(record.id);
      if (!hasRepos) {
        // Not attributing installedByUserId here — this user merely discovered
        // an installation that already existed on GitHub, they didn't install it.
        await syncInstallationFromGitHub(installations, remote.id, null);
      }
    }

    await userGithubAccess.touchSyncState(userId);
    return { status: "ok" };
  } catch (error) {
    console.error(`reconcileUserInstallations: upsert/sync failed for user ${userId}:`, error);
    return { status: "soft_fail" };
  }
}
