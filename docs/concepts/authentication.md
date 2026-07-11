# Authentication (API)

**Read this when:** you implement auth routes, session storage, GitHub OAuth,
or user provisioning in this repo.
**Skip if:** you need the full cross-component spec — see the meta repo's
[`../../../docs/concepts/authentication.md`](../../../docs/concepts/authentication.md).

> Canonical spec: meta repo `docs/concepts/authentication.md` and ADR 009
> (amending ADR 001). This page only records **API-owned** implementation notes.
> GitHub OAuth is the only sign-in method — there is no password code in this
> repo.

## Ownership

The API is the sole issuer of sessions and the OAuth client. The Web app never
handles `GITHUB_CLIENT_SECRET` or stores GitHub tokens.

## Module layout

```
src/
  auth/           # session middleware, cookies, logout/me/onboarding routes
  users/          # user CRUD, onboarding state
  github/         # OAuth (identity), App install/callback, webhooks, installation tokens
  db/             # migrations, session + user repositories
```

## Environment

From `api/.env.example`:

```
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_WEBHOOK_SECRET=
SESSION_SECRET=        # cookie signing
DATABASE_URL=
```

`GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are required in practice — without
them `GET /auth/github` returns 503, and there is no other way to sign in.

Callback URL (dev): `{API_PUBLIC_URL}/auth/github/callback`
(e.g. `http://localhost:8080/api/auth/github/callback`)

## Implementation notes

- PostgreSQL migrations: `users`, `sessions`, `github_tokens`, `oauth_states`
  (`src/db/migrations/001_auth.sql`).
- Session middleware (`HttpOnly`, `Path=/`, `SameSite=Lax`) — `src/auth/middleware.ts`.
- Single OAuth flow, no `intent` param — `src/github/routes.ts` looks up by
  `github_id`: found → login (refresh stored token); not found → auto-provision.
- `pending_username` gate enforced in `src/auth/routes.ts` /
  `src/auth/middleware.ts` before other routes.
- GitHub tokens (`src/github/token-repository.ts`) are stored **plaintext** in
  `github_tokens` — pre-existing gap, not addressed by ADR 009.

## Related

- Meta GitHub App spec: [`../../../docs/concepts/github-app.md`](../../../docs/concepts/github-app.md)
