# Authentication (API)

**Read this when:** you implement auth routes, session storage, password hashing,
GitHub OAuth, or user migrations in this repo.
**Skip if:** you need the full cross-component spec — see the meta repo's
[`../../../docs/concepts/authentication.md`](../../../docs/concepts/authentication.md).

> Canonical spec: meta repo `docs/concepts/authentication.md` and ADR 001.
> This page only records **API-owned** implementation notes.

## Ownership

The API is the sole issuer of sessions and the OAuth client. The Web app never
handles `GITHUB_CLIENT_SECRET` or stores GitHub tokens.

## Module layout (planned)

```
src/
  auth/           # routes, session middleware, rate limiting
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

Callback URL (dev): `{API_PUBLIC_URL}/auth/github/callback`  
(e.g. `http://localhost:8080/api/auth/github/callback`)

## Implementation checklist

- [ ] PostgreSQL migrations: `users`, `sessions`, `github_tokens`
- [ ] Session middleware (`HttpOnly`, `Path=/`, `SameSite=Lax`)
- [ ] Rate limiter on `POST /auth/login`
- [ ] OAuth state parameter (CSRF) per intent
- [ ] Encrypt GitHub tokens at rest
- [ ] `pending_username` gate enforced in middleware before other routes

## Related

- Meta GitHub App spec: [`../../../docs/concepts/github-app.md`](../../../docs/concepts/github-app.md)
