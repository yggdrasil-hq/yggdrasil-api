#!/usr/bin/env bash
#
# Run the API's whole test suite against a **real** PostgreSQL, converting the
# environment-skipped cases into real checks.
#
# **Why this exists.** Five test files verify against a real database and skip
# when they cannot reach one, printing what went unverified. That is deliberate —
# a fake pool has no opinion on whether Postgres *accepts* a statement, which is
# how #43 (a repository method that threw on every call), #61 (an audit query that
# 500'd on every request) and #56 (four endpoints at unreachable paths) each
# shipped behind a passing suite.
#
# But a skip is not a pass, and in the default `docker compose` run **29 tests
# skip** — so "the suite is green" means less than it appears to. Pointing
# `DATABASE_URL` at a reachable database drops that to **10**, and the 19 that
# become real are exactly the ones guarding the bugs above.
#
# **The recipe is not obvious**, which is why it is a script rather than a note.
# The compose test network cannot reach its own Postgres on this host (a VPN mesh
# claims Docker's auto-allocated subnets — see `src/testing/live-postgres.ts`), so
# the suite has to run on the *host* network and address the **dev** stack's
# Postgres, which is published on localhost. Eight `scripts/verify/*.mts` files
# each repeat that explanation; this is the one place it is executable.
#
# What it does NOT cover: the 10 remaining skips are the MinIO contract cases,
# and the dev MinIO publishes no host port, so it is unreachable the same way.
# Those stay skipped here — see `src/storage/client.test.ts`.
#
# Usage, from `api/`:
#
#   ./scripts/test-against-real-db.sh
#
set -uo pipefail

PG_CONTAINER="${PG_CONTAINER:-yggdrasil-dev-postgres-1}"
DB="verify_$$_$(date +%s)"
TEST_IMAGE="yggdrasil-api-test-test"

# Read the password from the running container rather than hardcoding it, so this
# keeps working if the dev stack is configured differently.
PG_PASSWORD="$(docker inspect "$PG_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | sed -n 's/^POSTGRES_PASSWORD=//p')"

if [ -z "$PG_PASSWORD" ]; then
  echo "Could not read POSTGRES_PASSWORD from $PG_CONTAINER." >&2
  echo "Is the dev stack up?  docker compose -f ../deploy/docker-compose.dev.yml ps" >&2
  exit 2
fi

echo "== creating scratch database $DB on $PG_CONTAINER =="
docker exec "$PG_CONTAINER" psql -U yggdrasil -d postgres -q -c "CREATE DATABASE $DB;" || exit 2

cleanup() {
  echo ""
  echo "== dropping $DB =="
  if docker exec "$PG_CONTAINER" psql -U yggdrasil -d postgres -q \
      -c "DROP DATABASE IF EXISTS $DB;" 2>/dev/null; then
    echo "dropped $DB"
  else
    # Not fatal, but it must be visible: agents in this sandbox are refused
    # DROP DATABASE, and a silent failure here leaves a database behind for
    # someone else to find. Say the name so it can be dropped by hand.
    echo "COULD NOT DROP $DB — needs dropping by hand:"
    echo "  docker exec $PG_CONTAINER psql -U yggdrasil -d postgres -c 'DROP DATABASE $DB;'"
  fi
}
trap cleanup EXIT INT TERM

echo "== running the suite against it (--network host) =="
docker run --rm --network host -v "$PWD":/app -w /app \
  -e NODE_ENV=test \
  -e DATABASE_URL="postgresql://yggdrasil:${PG_PASSWORD}@127.0.0.1:5432/$DB" \
  "$TEST_IMAGE" \
  sh -c './node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run --reporter=default'
status=$?

echo ""
if [ "$status" -eq 0 ]; then
  echo "Suite passed. Compare the skip count above against the compose run's 29 —"
  echo "the difference is the real-database cases that would otherwise be skipped."
else
  echo "Suite FAILED (exit $status). The scratch database is dropped on exit either way."
fi
exit "$status"
