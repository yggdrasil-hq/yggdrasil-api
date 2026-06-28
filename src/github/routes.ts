import { Router } from "express";
import { config, isGitHubOAuthConfigured, appPublicRedirect } from "../config.js";
import { clearSessionCookie, setSessionCookie } from "../auth/cookies.js";
import { createAuthMiddleware, optionalAuth } from "../auth/middleware.js";
import type { SessionService } from "../auth/sessions.js";
import { GithubTokenRepository } from "./token-repository.js";
import {
  buildGitHubAuthorizeUrl,
  exchangeGitHubCode,
  fetchGitHubUser,
  OAuthStateRepository,
  scopesForIntent,
  type OAuthIntent,
} from "./oauth.js";
import { UserRepository } from "../users/repository.js";
import { toPublicUser } from "../users/types.js";

const intentSchema = new Set<OAuthIntent>(["login", "signup", "link"]);

export function createGitHubRouter(deps: {
  users: UserRepository;
  sessions: SessionService;
  oauthStates: OAuthStateRepository;
  githubTokens: GithubTokenRepository;
}): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(deps.sessions, deps.users);
  const maybeAuth = optionalAuth(deps.sessions, deps.users);

  router.get("/github", maybeAuth, async (req, res) => {
    if (!isGitHubOAuthConfigured()) {
      res.status(503).json({ error: "GitHub OAuth is not configured" });
      return;
    }

    const intentParam = String(req.query.intent ?? "login");
    if (!intentSchema.has(intentParam as OAuthIntent)) {
      res.status(400).json({ error: "Invalid OAuth intent" });
      return;
    }
    const intent = intentParam as OAuthIntent;

    if (intent === "link" && !req.currentUser) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const returnTo =
      typeof req.query.return_to === "string" ? req.query.return_to : null;

    const oauthState = await deps.oauthStates.create({
      intent,
      userId: req.currentUser?.id ?? null,
      returnTo,
      scopes: scopesForIntent(intent),
    });

    const authorizeUrl = buildGitHubAuthorizeUrl({
      clientId: config.github.clientId,
      redirectUri: `${config.apiPublicUrl}/auth/github/callback`,
      state: oauthState.state,
      scopes: oauthState.scopes,
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

      if (oauthState.intent === "link") {
        if (!oauthState.userId) {
          res.redirect(appPublicRedirect("/settings/account", { error: "auth_required" }));
          return;
        }

        const existing = await deps.users.findByGithubId(githubId);
        if (existing && existing.id !== oauthState.userId) {
          res.redirect(
            appPublicRedirect("/settings/account", { error: "github_already_linked" }),
          );
          return;
        }

        await deps.githubTokens.upsert(
          oauthState.userId,
          token.accessToken,
          token.scopes.length > 0 ? token.scopes : oauthState.scopes,
        );
        await deps.users.linkGithub(oauthState.userId, githubId, githubUser.login);

        res.redirect(appPublicRedirect("/settings/account", { github: "connected" }));
        return;
      }

      const linkedUser = await deps.users.findByGithubId(githubId);
      if (linkedUser) {
        const session = await deps.sessions.create(linkedUser, false);
        setSessionCookie(res, session.id, false);

        if (linkedUser.onboardingState === "pending_username") {
          res.redirect(appPublicRedirect("/onboarding/confirm-username"));
          return;
        }

        res.redirect(appPublicRedirect(oauthState.returnTo ?? "/"));
        return;
      }

      if (oauthState.intent === "login") {
        res.redirect(
          appPublicRedirect("/login", {
            error: "github_unlinked",
            github_login: githubUser.login,
          }),
        );
        return;
      }

      let username = githubUser.login.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
      if (!/^[a-z0-9_-]{3,32}$/.test(username)) {
        username = `gh_${githubId.slice(0, 8)}`;
      }
      if (await deps.users.isUsernameTaken(username)) {
        username = `${username.slice(0, 24)}_${githubId.slice(-4)}`.slice(0, 32);
      }

      const user = await deps.users.createGithubUser({
        username,
        displayName: githubUser.name ?? githubUser.login,
        githubId,
        githubLogin: githubUser.login,
      });

      await deps.githubTokens.upsert(user.id, token.accessToken, token.scopes);

      const session = await deps.sessions.create(user, false);
      setSessionCookie(res, session.id, false);
      res.redirect(appPublicRedirect("/onboarding/confirm-username"));
    } catch {
      res.redirect(appPublicRedirect("/login", { error: "github_failed" }));
    }
  });

  router.get("/github/unlinked", (_req, res) => {
    res.json({
      message: "No Yggdrasil account linked to this GitHub identity.",
    });
  });

  return router;
}
