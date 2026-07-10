import { Router } from "express";
import { config, appPublicRedirect, isGitHubAppConfigured } from "../config.js";
import { createAuthMiddleware } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { UserRepository } from "../users/repository.js";
import { InstallStateRepository } from "./install-state.js";
import { GithubInstallationRepository } from "./installation-repository.js";
import { GithubTokenRepository } from "./token-repository.js";
import { UserGithubAccessRepository } from "./user-github-access-repository.js";
import { syncInstallationFromGitHub } from "./sync-installation.js";
import { reconcileUserInstallations } from "./reconcile-user-installations.js";

const SYNC_STALE_MS = 60 * 60 * 1000; // 1 hour

export function createGitHubAppRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  installations: GithubInstallationRepository;
  installStates: InstallStateRepository;
  githubTokens: GithubTokenRepository;
  userGithubAccess: UserGithubAccessRepository;
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
    const targetId = typeof req.query.target_id === "string" ? req.query.target_id.trim() : "";
    if (targetId) {
      params.set("target_id", targetId);
    }
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
      await deps.userGithubAccess.upsertAccess(installState.userId, synced.id);

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

  router.get("/installations", requireAuth, async (req, res) => {
    const userId = req.currentUser!.id;
    const forceRefresh = req.query.refresh === "1";

    let reauthRequired = false;
    let stale = false;

    const lastSyncedAt = await deps.userGithubAccess.getLastSyncedAt(userId);
    const isStale = !lastSyncedAt || Date.now() - lastSyncedAt.getTime() > SYNC_STALE_MS;

    if (forceRefresh || isStale) {
      const result = await reconcileUserInstallations({
        githubTokens: deps.githubTokens,
        installations: deps.installations,
        userGithubAccess: deps.userGithubAccess,
        userId,
      });
      if (result.status === "reauth_required") {
        reauthRequired = true;
      } else if (result.status === "soft_fail") {
        stale = true;
      }
    }

    const installations = await deps.installations.listForUser(userId);
    const repos = await deps.installations.listRepositoriesForUser(userId);

    res.json({
      installations: installations.map((installation) => ({
        id: installation.id,
        accountType: installation.accountType,
        accountLogin: installation.accountLogin,
        githubInstallationId: installation.githubInstallationId,
      })),
      repos: repos.map((repo) => {
        const [owner, name] = repo.repoFullName.split("/");
        return {
          installationId: repo.installationId,
          accountLogin: repo.accountLogin,
          fullName: repo.repoFullName,
          githubOwner: owner,
          githubRepo: name,
        };
      }),
      reauthRequired,
      stale,
    });
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
