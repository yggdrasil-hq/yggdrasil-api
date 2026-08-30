import { Router } from "express";
import { config, isGitHubOAuthConfigured, appPublicRedirect } from "../config.js";
import { setSessionCookie } from "../auth/cookies.js";
import type { SessionService } from "../auth/sessions.js";
import { GithubTokenRepository } from "./token-repository.js";
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCode,
  fetchGitHubUser,
  OAuthStateRepository,
} from "./oauth.js";
import { UserRepository } from "../users/repository.js";
import type { OrganizationRepository } from "../organizations/repository.js";

export function createGitHubRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  oauthStates: OAuthStateRepository;
  githubTokens: GithubTokenRepository;
  organizations: OrganizationRepository;
}): Router {
  const router = Router();

  router.get("/github", async (req, res) => {
    if (!isGitHubOAuthConfigured()) {
      res.status(503).json({ error: "GitHub OAuth is not configured" });
      return;
    }

    const returnTo =
      typeof req.query.return_to === "string" ? req.query.return_to : null;

    const oauthState = await deps.oauthStates.create({ returnTo });

    const authorizeUrl = buildGitHubAuthorizeUrl({
      clientId: config.github.clientId,
      redirectUri: `${config.apiPublicUrl}/auth/github/callback`,
      state: oauthState.state,
    });

    res.redirect(authorizeUrl);
  });

  router.get("/github/callback", async (req, res) => {
    if (!isGitHubOAuthConfigured()) {
      res.redirect(appPublicRedirect("/login", { error: "github_not_configured" }));
      return;
    }

    const error = typeof req.query.error === "string" ? req.query.error : null;
    if (error) {
      res.redirect(appPublicRedirect("/login", { error: "github_denied" }));
      return;
    }

    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state) {
      res.redirect(appPublicRedirect("/login", { error: "github_invalid" }));
      return;
    }

    const oauthState = await deps.oauthStates.consume(state);
    if (!oauthState) {
      res.redirect(appPublicRedirect("/login", { error: "github_state_invalid" }));
      return;
    }

    try {
      const token = await exchangeGitHubCode(
        code,
        config.github.clientId,
        config.github.clientSecret,
      );
      const githubUser = await fetchGitHubUser(token.accessToken);
      const githubId = String(githubUser.id);

      let user = await deps.users.findByGithubId(githubId);
      if (!user) {
        let username = githubUser.login.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
        if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
          username = `gh_${githubId.slice(0, 8)}`;
        }
        if (await deps.users.isUsernameTaken(username)) {
          username = `${username.slice(0, 24)}_${githubId.slice(-4)}`.slice(0, 32);
        }

        user = await deps.users.createGithubUser({
          username,
          displayName: githubUser.name ?? githubUser.login,
          githubId,
          githubLogin: githubUser.login,
        });

        // ADR 016 item 2: every user gets a personal Organization auto-created
        // at signup, so a solo/2-10 person user can create a project without
        // an explicit "create an org" step. Personal orgs are otherwise
        // unrestricted (others can be invited into them later); the flag only
        // governs auto-creation and default routing.
        await deps.organizations.create({
          name: `${githubUser.name ?? githubUser.login}'s workspace`,
          description: "",
          isPersonal: true,
          creatorUserId: user.id,
        });
      }

      await deps.githubTokens.upsert(user.id, token.accessToken, token.scopes, token.refreshToken);

      const session = await deps.sessions.create(user, false);
      setSessionCookie(res, session.id, false);

      if (user.onboardingState === "pending_username") {
        res.redirect(appPublicRedirect("/onboarding/confirm-username"));
        return;
      }

      if (oauthState.returnTo) {
        res.redirect(appPublicRedirect(oauthState.returnTo, { github: "connected" }));
        return;
      }
      res.redirect(appPublicRedirect("/"));
    } catch {
      res.redirect(appPublicRedirect("/login", { error: "github_failed" }));
    }
  });

  return router;
}
