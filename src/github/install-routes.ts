import { Router } from "express";
import { config, appPublicRedirect, isGitHubAppConfigured } from "../config.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import { InstallStateRepository } from "./install-state.js";
import { GithubInstallationRepository } from "./installation-repository.js";
import { syncInstallationFromGitHub } from "./sync-installation.js";

export function createGitHubAppRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  installations: GithubInstallationRepository;
  installStates: InstallStateRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);

  router.get("/install", requireAuth, async (req, res) => {
    if (!isGitHubAppConfigured()) {
      res.status(503).json({ error: "GitHub App is not configured" });
      return;
    }

    const draftName = typeof req.query.name === "string" ? req.query.name.trim() : "";
    if (!draftName) {
      res.status(400).json({ error: "Project name is required to start install" });
      return;
    }

    const draftDescription =
      typeof req.query.description === "string" ? req.query.description : "";
    const returnTo =
      typeof req.query.return_to === "string" ? req.query.return_to : null;

    const installState = await deps.installStates.create({
      userId: req.currentUser!.id,
      draftName,
      draftDescription,
      returnTo,
    });

    const params = new URLSearchParams({ state: installState.state });
    const installUrl = `https://github.com/apps/${config.github.appSlug}/installations/new?${params.toString()}`;
    res.redirect(installUrl);
  });

  router.get("/install/callback", async (req, res) => {
    if (!isGitHubAppConfigured()) {
      res.redirect(appPublicRedirect("/projects/new", { error: "github_app_not_configured" }));
      return;
    }

    const installationIdParam = req.query.installation_id;
    const setupAction = typeof req.query.setup_action === "string" ? req.query.setup_action : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;

    if (!installationIdParam || !state) {
      res.redirect(appPublicRedirect("/projects/new", { error: "github_install_invalid" }));
      return;
    }

    const githubInstallationId = Number(installationIdParam);
    if (!Number.isFinite(githubInstallationId)) {
      res.redirect(appPublicRedirect("/projects/new", { error: "github_install_invalid" }));
      return;
    }

    const installState = await deps.installStates.consume(state);
    if (!installState) {
      res.redirect(appPublicRedirect("/projects/new", { error: "github_install_state_invalid" }));
      return;
    }

    try {
      const synced = await syncInstallationFromGitHub(
        deps.installations,
        githubInstallationId,
        installState.userId,
      );

      const params: Record<string, string> = {
        step: "repos",
        installation_id: synced.id,
        name: installState.draftName,
      };
      if (installState.draftDescription) {
        params.description = installState.draftDescription;
      }
      if (setupAction === "update") {
        params.configure = "1";
      }

      res.redirect(appPublicRedirect(installState.returnTo ?? "/projects/new", params));
    } catch {
      res.redirect(appPublicRedirect("/projects/new", { error: "github_install_failed" }));
    }
  });

  router.get("/installations", requireAuth, async (_req, res) => {
    const installations = await deps.installations.listAll();
    res.json(
      installations.map((installation) => ({
        id: installation.id,
        accountType: installation.accountType,
        accountLogin: installation.accountLogin,
        githubInstallationId: installation.githubInstallationId,
      })),
    );
  });

  router.get("/installations/:installationId/repos", requireAuth, async (req, res) => {
    const installation = await deps.installations.findById(
      String(req.params.installationId),
    );
    if (!installation || installation.suspendedAt) {
      res.status(404).json({ error: "Installation not found" });
      return;
    }

    const repos = await deps.installations.listRepositories(installation.id);
    res.json(
      repos.map((repo) => {
        const [owner, name] = repo.repoFullName.split("/");
        return {
          fullName: repo.repoFullName,
          githubOwner: owner,
          githubRepo: name,
        };
      }),
    );
  });

  router.get("/installations/:installationId/configure-url", requireAuth, async (req, res) => {
    if (!isGitHubAppConfigured()) {
      res.status(503).json({ error: "GitHub App is not configured" });
      return;
    }

    const installation = await deps.installations.findById(
      String(req.params.installationId),
    );
    if (!installation) {
      res.status(404).json({ error: "Installation not found" });
      return;
    }

    res.json({
      url: `https://github.com/apps/${config.github.appSlug}/installations/${installation.githubInstallationId}`,
    });
  });

  router.post(
    "/installations/:installationId/sync",
    requireAuth,
    async (req, res) => {
      if (!isGitHubAppConfigured()) {
        res.status(503).json({ error: "GitHub App is not configured" });
        return;
      }

      const installation = await deps.installations.findById(
        String(req.params.installationId),
      );
      if (!installation) {
        res.status(404).json({ error: "Installation not found" });
        return;
      }

      try {
        await syncInstallationFromGitHub(
          deps.installations,
          installation.githubInstallationId,
          req.currentUser!.id,
        );
        const repos = await deps.installations.listRepositories(installation.id);
        res.json(
          repos.map((repo) => {
            const [owner, name] = repo.repoFullName.split("/");
            return {
              fullName: repo.repoFullName,
              githubOwner: owner,
              githubRepo: name,
            };
          }),
        );
      } catch {
        res.status(502).json({ error: "Failed to sync installation from GitHub" });
      }
    },
  );

  return router;
}
