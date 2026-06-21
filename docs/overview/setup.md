# API — local setup

**Read this when:** you're setting up or running this component locally.

## Full stack (recommended)

From the meta repo root:

```bash
./setup.sh
docker compose -f deploy/docker-compose.dev.yml up --build api
```

API is reachable at http://localhost:8080/api (via nginx).

## This repo only

```bash
./setup.sh   # from meta repo root, or: cp .env.example .env
npm install
npm run dev
```

Health: http://localhost:3000/health

## Tests (CI parity)

```bash
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from test
```

## Environment variables

See `.env.example`. Infra URLs (`DATABASE_URL`, `S3_*`) are set by root
`deploy/.env` when using the full stack.
