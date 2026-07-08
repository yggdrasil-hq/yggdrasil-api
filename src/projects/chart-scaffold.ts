import { config } from "../config.js";
import { mintInstallationAccessToken, putRepositoryFile } from "../github/github-api.js";
import type { GithubInstallation } from "../github/installation-repository.js";
import { CHART_TEMPLATE_FILES } from "./chart-template.js";
import type { Project } from "./types.js";

const CHART_DIR = ".yggdrasil/chart";

/**
 * Best-effort: scaffolds the fixed Helm chart template into the project's
 * primary repo (ADR 003 §12). Never throws — a scaffold failure shouldn't
 * block project creation; callers should notify the user instead. Returns
 * true if every file was written successfully.
 */
export async function scaffoldChart(
  project: Project,
  installation: GithubInstallation,
): Promise<boolean> {
  const primary = project.repositories.find((repo) => repo.isPrimary);
  if (!primary) {
    console.error(`scaffoldChart: project ${project.id} has no primary repository`);
    return false;
  }

  let token: string;
  try {
    ({ token } = await mintInstallationAccessToken(
      installation.githubInstallationId,
      config.github.appId,
      config.github.appPrivateKey,
    ));
  } catch (error) {
    console.error(`scaffoldChart: failed to mint installation token for project ${project.id}:`, error);
    return false;
  }

  let allSucceeded = true;
  for (const [relativePath, content] of Object.entries(CHART_TEMPLATE_FILES)) {
    try {
      await putRepositoryFile(
        primary.githubOwner,
        primary.githubRepo,
        `${CHART_DIR}/${relativePath}`,
        content,
        `chore: scaffold Yggdrasil Helm chart (${relativePath})`,
        token,
      );
    } catch (error) {
      console.error(
        `scaffoldChart: failed to write ${relativePath} for project ${project.id}:`,
        error,
      );
      allSucceeded = false;
    }
  }

  return allSucceeded;
}
