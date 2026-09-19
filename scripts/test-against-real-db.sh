#!/usr/bin/env bash
#
# Run the API's whole test suite against a **real** PostgreSQL, converting the
# environment-skipped cases into real checks.
#
# **Why this exists.** Ten test files verify against a real PostgreSQL and skip in
# full when they cannot reach one, printing what went unverified. That is
# deliberate — a fake pool has no opinion on whether Postgres *accepts* a
# statement, which is how #43 (a repository method that threw on every call), #61
# (an audit query that 500'd on every request) and #56 (four endpoints at
# unreachable paths) each shipped behind a passing suite.
#
# But a skip is not a pass, and in the default `docker compose` run on this
# project's dev host **77 tests skip** — so "the suite is green" means less than it
# appears to. Pointing `DATABASE_URL` at a reachable database drops that to **10**,
# and the **67** that become real are exactly the ones guarding the bugs above.
#
# **Both figures are measured, and both are environment-dependent**: they count the
# cases that cannot reach a database from wherever the suite is running, so a host
# that can reach one skips fewer and leaves this script less to recover — CI's own
# run of the compose half skips **none**, which is why the dev-host figure is the one
# that makes this script worth running. Issue #105 found this header claiming 29 and
# 19 for several waves after the truth had moved to 77 and 67, and the lesson is not
# "write a better number": it is that a run's **own summary line** is the only
# authority for a count like this, and a second copy in prose has nothing to fail when
# it drifts. The closing message below therefore reports what it observed and points
# back at that summary, and the docs quote a figure only alongside the recipe for
# re-measuring it.
#
# To re-measure the pair, run both and read their summaries:
#
#   docker compose -f docker-compose.test.yml up --build \
#     --abort-on-container-exit --exit-code-from test | tail -3
#   ./scripts/test-against-real-db.sh
#
# The first reports `Tests  <n> passed | 77 skipped`; the second reports
# `<n> passed | 10 skipped`. The difference between the two skip counts is what
# this script recovered.
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
# This run's own output, kept so the closing message can report the numbers it
# actually observed rather than repeating a figure written into the script (#105).
LOG="$(mktemp -t yggdrasil-real-db.XXXXXX)"

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
  rm -f "$LOG"
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
  sh -c './node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run --reporter=default' \
  2>&1 | tee "$LOG"
# `${PIPESTATUS[0]}`, not `$?`: the status that matters is the suite's, and naming
# the element says which command's it is. (`pipefail` would also carry it, but only
# by way of `tee`, which is a different sentence to read.)
status=${PIPESTATUS[0]}

echo ""
if [ "$status" -eq 0 ]; then
  echo "Suite passed. The skip count on the summary line above is this run's, and it is"
  echo "the authority for that number — not a figure written into this script, which is"
  echo "how the one in docs/conventions/testing.md stayed at 29 while the truth was 77"
  echo "(issue #105). Compare it against the compose run's own summary line; the"
  echo "difference between the two is what this script recovered."
  # Reported rather than asserted, for the reason above. Empty when the suite had no
  # skips at all, in which case there is no comparison to offer and no line printed.
  observed="$(grep -aoE 'Tests +[0-9]+ passed \| [0-9]+ skipped' "$LOG" | tail -1 | grep -aoE '[0-9]+' | tail -1)"
  if [ -n "$observed" ]; then
    echo ""
    echo "This run: ${observed} skipped. Re-measure the pair by running both halves and"
    echo "reading their summaries — the header of this script has both commands."
  fi
else
  echo "Suite FAILED (exit $status). The scratch database is dropped on exit either way."
fi
exit "$status"
