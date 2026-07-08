import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubInstallation } from "../github/installation-repository.js";
import type { Project } from "./types.js";

vi.mock("../github/github-api.js", () => ({
  mintInstallationAccessToken: vi.fn(),
  putRepositoryFile: vi.fn(),
}));

const { mintInstallationAccessToken, putRepositoryFile } = await import("../github/github-api.js");
const { scaffoldChart } = await import("./chart-scaffold.js");
const { CHART_TEMPLATE_FILES } = await import("./chart-template.js");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj_1",
    ownerUserId: "user_1",
    name: "Test",
    slug: "test",
    description: "",
    status: "ready",
    settings: {},
    installationId: "inst_1",
    githubAccessWarning: false,
    repositories: [
      { id: "repo_1", githubOwner: "acme", githubRepo: "web", isPrimary: true, sortOrder: 0 },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeInstallation(overrides: Partial<GithubInstallation> = {}): GithubInstallation {
  return {
    id: "inst_1",
    githubInstallationId: 42,
    accountType: "Organization",
    accountLogin: "acme",
    accountId: 1,
    installedByUserId: null,
    suspendedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("scaffoldChart", () => {
  beforeEach(() => {
    vi.mocked(mintInstallationAccessToken).mockReset();
    vi.mocked(putRepositoryFile).mockReset();
  });

  it("writes every template file under .yggdrasil/chart on main, using a freshly minted token", async () => {
    vi.mocked(mintInstallationAccessToken).mockResolvedValue({
      token: "tok_abc",
      expiresAt: new Date(),
    });
    vi.mocked(putRepositoryFile).mockResolvedValue(undefined);

    const result = await scaffoldChart(makeProject(), makeInstallation());

    expect(result).toBe(true);
    expect(mintInstallationAccessToken).toHaveBeenCalledWith(42, expect.any(String), expect.any(String));

    const expectedPaths = Object.keys(CHART_TEMPLATE_FILES).map((p) => `.yggdrasil/chart/${p}`);
    expect(putRepositoryFile).toHaveBeenCalledTimes(expectedPaths.length);
    for (const path of expectedPaths) {
      expect(putRepositoryFile).toHaveBeenCalledWith(
        "acme",
        "web",
        path,
        expect.any(String),
        expect.any(String),
        "tok_abc",
      );
    }
  });

  it("returns false and does not throw when a file write fails", async () => {
    vi.mocked(mintInstallationAccessToken).mockResolvedValue({
      token: "tok_abc",
      expiresAt: new Date(),
    });
    vi.mocked(putRepositoryFile).mockRejectedValue(new Error("GitHub API PUT failed: 500"));

    const result = await scaffoldChart(makeProject(), makeInstallation());

    expect(result).toBe(false);
  });

  it("attempts every file even if an earlier one fails", async () => {
    vi.mocked(mintInstallationAccessToken).mockResolvedValue({
      token: "tok_abc",
      expiresAt: new Date(),
    });
    vi.mocked(putRepositoryFile)
      .mockRejectedValueOnce(new Error("first file failed"))
      .mockResolvedValue(undefined);

    const result = await scaffoldChart(makeProject(), makeInstallation());

    expect(result).toBe(false);
    expect(putRepositoryFile).toHaveBeenCalledTimes(Object.keys(CHART_TEMPLATE_FILES).length);
  });

  it("returns false without minting a token when the project has no primary repository", async () => {
    const project = makeProject({
      repositories: [
        { id: "repo_1", githubOwner: "acme", githubRepo: "web", isPrimary: false, sortOrder: 0 },
      ],
    });

    const result = await scaffoldChart(project, makeInstallation());

    expect(result).toBe(false);
    expect(mintInstallationAccessToken).not.toHaveBeenCalled();
    expect(putRepositoryFile).not.toHaveBeenCalled();
  });

  it("returns false when minting the installation token fails", async () => {
    vi.mocked(mintInstallationAccessToken).mockRejectedValue(new Error("token mint failed"));

    const result = await scaffoldChart(makeProject(), makeInstallation());

    expect(result).toBe(false);
    expect(putRepositoryFile).not.toHaveBeenCalled();
  });
});
