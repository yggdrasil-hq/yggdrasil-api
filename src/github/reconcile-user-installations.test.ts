import { describe, expect, it, vi, beforeEach } from "vitest";
import { GithubApiUnauthorizedError } from "./github-api.js";
import { reconcileUserInstallations } from "./reconcile-user-installations.js";

vi.mock("./github-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./github-api.js")>();
  return {
    ...actual,
    fetchUserInstallations: vi.fn(),
    refreshUserOAuthToken: vi.fn(),
  };
});

vi.mock("./sync-installation.js", () => ({
  syncInstallationFromGitHub: vi.fn().mockResolvedValue({ id: "install_1" }),
}));

const { fetchUserInstallations, refreshUserOAuthToken } = await import("./github-api.js");
const { syncInstallationFromGitHub } = await import("./sync-installation.js");

function makeDeps(overrides: {
  token?: { accessToken: string; refreshToken: string | null; scopes: string[] } | null;
  hasRepos?: boolean;
} = {}) {
  const githubTokens = {
    get: vi.fn().mockResolvedValue(
      overrides.token === undefined
        ? { accessToken: "tok_1", refreshToken: "refresh_1", scopes: ["read:user"] }
        : overrides.token,
    ),
    updateAccessToken: vi.fn().mockResolvedValue(undefined),
  };
  const installations = {
    upsertFromGitHub: vi.fn().mockResolvedValue({ id: "install_1" }),
    hasAnyRepositories: vi.fn().mockResolvedValue(overrides.hasRepos ?? false),
  };
  const userGithubAccess = {
    upsertAccess: vi.fn().mockResolvedValue(undefined),
    touchSyncState: vi.fn().mockResolvedValue(undefined),
  };
  return { githubTokens, installations, userGithubAccess };
}

function remoteInstallation(overrides: Partial<{ id: number; login: string }> = {}) {
  return {
    id: overrides.id ?? 111,
    account: { id: 999, login: overrides.login ?? "acme-corp", type: "Organization" as const },
    suspended_at: null,
  };
}

beforeEach(() => {
  vi.mocked(fetchUserInstallations).mockReset();
  vi.mocked(refreshUserOAuthToken).mockReset();
  vi.mocked(syncInstallationFromGitHub).mockClear();
});

describe("reconcileUserInstallations", () => {
  it("discovers an installation and auto-syncs repos when none are synced yet", async () => {
    vi.mocked(fetchUserInstallations).mockResolvedValue([remoteInstallation()]);
    const deps = makeDeps({ hasRepos: false });

    const result = await reconcileUserInstallations({ ...deps, userId: "user_1" } as never);

    expect(result).toEqual({ status: "ok" });
    expect(deps.installations.upsertFromGitHub).toHaveBeenCalledWith(
      expect.objectContaining({ githubInstallationId: 111, accountLogin: "acme-corp" }),
    );
    expect(deps.userGithubAccess.upsertAccess).toHaveBeenCalledWith("user_1", "install_1");
    expect(syncInstallationFromGitHub).toHaveBeenCalledWith(deps.installations, 111, null);
    expect(deps.userGithubAccess.touchSyncState).toHaveBeenCalledWith("user_1");
  });

  it("does not re-sync repos for an installation that already has them", async () => {
    vi.mocked(fetchUserInstallations).mockResolvedValue([remoteInstallation()]);
    const deps = makeDeps({ hasRepos: true });

    const result = await reconcileUserInstallations({ ...deps, userId: "user_1" } as never);

    expect(result).toEqual({ status: "ok" });
    expect(syncInstallationFromGitHub).not.toHaveBeenCalled();
  });

  it("silently refreshes an expired token and retries on 401", async () => {
    vi.mocked(fetchUserInstallations)
      .mockRejectedValueOnce(new GithubApiUnauthorizedError("/user/installations"))
      .mockResolvedValueOnce([remoteInstallation()]);
    vi.mocked(refreshUserOAuthToken).mockResolvedValue({
      accessToken: "tok_2",
      refreshToken: "refresh_2",
    });
    const deps = makeDeps({ hasRepos: true });

    const result = await reconcileUserInstallations({ ...deps, userId: "user_1" } as never);

    expect(result).toEqual({ status: "ok" });
    expect(deps.githubTokens.updateAccessToken).toHaveBeenCalledWith("user_1", "tok_2", "refresh_2");
    expect(fetchUserInstallations).toHaveBeenCalledTimes(2);
  });

  it("requires reauth when the token has no refresh_token to fall back on", async () => {
    vi.mocked(fetchUserInstallations).mockRejectedValue(
      new GithubApiUnauthorizedError("/user/installations"),
    );
    const deps = makeDeps({ token: { accessToken: "tok_1", refreshToken: null, scopes: [] } });

    const result = await reconcileUserInstallations({ ...deps, userId: "user_1" } as never);

    expect(result).toEqual({ status: "reauth_required" });
    expect(refreshUserOAuthToken).not.toHaveBeenCalled();
  });

  it("requires reauth when the refresh_token itself is rejected", async () => {
    vi.mocked(fetchUserInstallations).mockRejectedValue(
      new GithubApiUnauthorizedError("/user/installations"),
    );
    vi.mocked(refreshUserOAuthToken).mockRejectedValue(
      new GithubApiUnauthorizedError("/login/oauth/access_token (refresh)"),
    );
    const deps = makeDeps();

    const result = await reconcileUserInstallations({ ...deps, userId: "user_1" } as never);

    expect(result).toEqual({ status: "reauth_required" });
  });

  it("requires reauth when no token is stored for the user at all", async () => {
    const deps = makeDeps({ token: null });

    const result = await reconcileUserInstallations({ ...deps, userId: "user_1" } as never);

    expect(result).toEqual({ status: "reauth_required" });
    expect(fetchUserInstallations).not.toHaveBeenCalled();
  });

  it("fails soft on a transient GitHub error, without requiring reauth", async () => {
    vi.mocked(fetchUserInstallations).mockRejectedValue(new Error("network error"));
    const deps = makeDeps();

    const result = await reconcileUserInstallations({ ...deps, userId: "user_1" } as never);

    expect(result).toEqual({ status: "soft_fail" });
  });

  it("fails soft if a downstream write throws after a successful fetch", async () => {
    vi.mocked(fetchUserInstallations).mockResolvedValue([remoteInstallation()]);
    const deps = makeDeps();
    deps.userGithubAccess.upsertAccess.mockRejectedValue(new Error("db error"));

    const result = await reconcileUserInstallations({ ...deps, userId: "user_1" } as never);

    expect(result).toEqual({ status: "soft_fail" });
  });
});
