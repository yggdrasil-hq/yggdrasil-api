#!/usr/bin/env bash
# Two-replica live-relay fan-out verification (issue #32).
#
# Uses the EXISTING dev stack's Postgres (on yggdrasil-dev_default), per the
# coordinator's guidance: that removes the question of whether a fresh Postgres
# will accept a connection, and it is closer to what #32 asks — two API replicas
# sharing one database. The operator's own database is NOT used: this creates and
# uses a scratch database (`relay_verify`), so nothing lands in their data.
#
# The API image is the repo's own test image, so the code under test is the repo's.
set -uo pipefail

REPO=/home/mugiwara/files/personal/projects/apps/yggdrasil
API_DIR="$REPO/api"
# The script's own directory, so the *committed* copy is what runs. This was
# hardcoded to /tmp/relay-verify while the harness lived outside its home repo,
# which meant the README described a harness nobody could run without copying
# files there first — the opposite of the reproducibility it was committed for.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NET=yggdrasil-dev_default
PG=yggdrasil-dev-postgres-1
DB=relay_verify
A=rv-api-a
B=rv-api-b
NGINX=rv-nginx
IMAGE=rv-api:verify
TOKEN=relay-verify-token
IDLE_SECONDS="${IDLE_SECONDS:-90}"
PGURL_HOST="postgresql://yggdrasil:change-me@postgres:5432/$DB"

cleanup() {
  set +e
  echo ""
  echo "== cleanup =="
  for c in "$A" "$B" "$NGINX"; do
    docker rm -f "$c" >/dev/null 2>&1 && echo "removed container $c"
  done
  docker image rm -f "$IMAGE" >/dev/null 2>&1 && echo "removed image $IMAGE"
  if docker exec "$PG" psql -U yggdrasil -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1; then
    echo "dropped scratch database $DB"
  else
    echo "COULD NOT DROP scratch database $DB — needs dropping by hand"
  fi
  echo "leftover rv-* objects:"
  docker ps -a --format '{{.Names}}' | grep -E '^rv-' || echo "  (none)"
  docker image ls --format '{{.Repository}}' | grep -E '^rv-' || echo "  (no rv- images)"
}
trap cleanup EXIT INT TERM

echo "== scratch database (in the existing dev Postgres; operator's DB untouched) =="
docker exec "$PG" psql -U yggdrasil -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
docker exec "$PG" psql -U yggdrasil -d postgres -c "CREATE DATABASE $DB" >/dev/null
echo "created $DB"

echo "== api image (repo's own test image) =="
docker build -q -t "$IMAGE" -f "$API_DIR/deploy/Dockerfile.test" "$API_DIR" >/dev/null
echo "built $IMAGE"

# A valid 32-byte base64 value, generated here rather than read from the
# operator's configuration, so this harness carries none of their values. Held
# in a variable rather than written to disk, so it leaves no file behind.
KEY="$(docker run --rm "$IMAGE" node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))')"

start_replica() {
  local name="$1"
  # NODE_ENV must not be "test": index.ts calls main() only when it is not, and the
  # test image sets NODE_ENV=test for its own entrypoint.
  docker run -d --name "$name" --network "$NET" \
    -e NODE_ENV=production \
    -e PORT=3000 \
    -e DATABASE_URL="$PGURL_HOST" \
    -e SECRETS_ENCRYPTION_KEY="$KEY" \
    -e INTERNAL_API_TOKEN="$TOKEN" \
    -e APP_PUBLIC_URL="http://localhost:8080/app" \
    -e API_PUBLIC_URL="http://localhost:8080/api" \
    -e TEST_SCHEDULER_ENABLED=false \
    "$IMAGE" ./node_modules/.bin/tsx src/index.ts >/dev/null
}

echo "== two api replicas, one database, started TOGETHER =="
# Deliberately simultaneous. This used to be serialised — start A, wait for
# "API listening", then start B — because two replicas booting at once both saw
# the same migration as unapplied, both applied it, and the loser died on
# `schema_migrations_pkey` and never served (#76). `runMigrations` now takes an
# advisory lock, so the race is gone and the workaround is removed.
#
# Keeping the simultaneous start is the point: it is what exercises the fix on
# every run of this harness, rather than only in the one-off check that was made
# when the lock was added.
start_replica "$A"
start_replica "$B"
echo "started $A and $B simultaneously"

echo "== nginx (two-replica upstream; API directives copied from deploy/nginx/dev.conf) =="
docker run -d --name "$NGINX" --network "$NET" \
  -v "$HERE/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine >/dev/null
echo "started $NGINX"

echo "== waiting for migrations (first replica to boot applies them) =="
# Issue #97. This used to wait on `to_regclass('public.sessions') is not null`, and
# `sessions` is created by migration 001 of 51. Because the replicas are started
# simultaneously on purpose (to exercise #76's advisory lock), the loser is still
# applying the rest when that probe goes true, so the wait ended long before the
# database was ready.
#
# The gap was wider than "001 of 51" suggests, which is worth recording: the
# fixtures need `features` (migration 002) *and* `organizations` /
# `organization_memberships` (013) *and* `projects.organization_id` (015). So the
# window in which fixtures.sql could run against an incomplete schema spanned
# fourteen migrations, not one — and a fixture that lands half-applied is exactly
# the intermittent failure that reads as flakiness in the relay.
#
# Counting the ledger against the number of migration *files* is the check that
# means "migrations complete" rather than "migrations started", and it needs no
# edit when a migration is added — unlike naming a table from the newest migration,
# which silently rots the next time one lands after it.
EXPECTED_MIGRATIONS="$(find "$API_DIR/src/db/migrations" -name '*.sql' | wc -l | tr -d '[:space:]')"
migrations_applied=""
for _ in $(seq 1 120); do
  migrations_applied="$(docker exec "$PG" psql -U yggdrasil -d "$DB" -tAc \
      "select count(*) from schema_migrations" 2>/dev/null | tr -d '[:space:]')"
  if [ "${migrations_applied:-}" = "$EXPECTED_MIGRATIONS" ]; then
    break
  fi
  sleep 1
done

# Fatal, not merely reported. The old code fell through to the fixtures whatever
# the state, and because `set -uo pipefail` is set with no `-e`, nothing downstream
# noticed. Stopping here names the real cause instead of letting it surface later
# as a socket refusal — the failure mode #97 is about.
if [ "${migrations_applied:-}" != "$EXPECTED_MIGRATIONS" ]; then
  echo "" >&2
  echo "FATAL: migrations did not finish: ${migrations_applied:-0} of $EXPECTED_MIGRATIONS" >&2
  echo "       applied after 120s. Stopping, because inserting fixtures into a" >&2
  echo "       half-migrated schema fails later as a socket refusal naming the" >&2
  echo "       wrong cause (#97). Check the replica logs printed below." >&2
  exit 1
fi
echo "  migrations applied: $migrations_applied of $EXPECTED_MIGRATIONS"

echo "== fixtures (fixed UUIDs; see fixtures.sql) =="
# Issue #97, second half. `ON_ERROR_STOP=1` is load-bearing and its absence was
# worse than the issue records. A fixture failure here does **not** surface as a
# non-zero exit on its own: psql reading a script from stdin returns 0 even after
# a failed statement (marked by `-c`, where it returns 1 — which is why this is
# easy to get wrong), so the original `psql ... < fixtures.sql && echo "inserted"`
# printed **inserted** over a fixture that never landed. The harness then reported
# success at the fixture step and failed later, as `subscribe refused … "Feature
# not found"` — a correct socket refusal naming a cause that was not the cause.
#
# So both halves are needed: `ON_ERROR_STOP=1` makes psql exit 3 on the first
# error, and the explicit check makes that exit fatal rather than decorative.
if ! docker exec -i "$PG" psql -U yggdrasil -d "$DB" -q -v ON_ERROR_STOP=1 \
    < "$HERE/fixtures.sql"; then
  echo "" >&2
  echo "FATAL: fixtures.sql failed. Stopping rather than continuing, because the" >&2
  echo "       run would otherwise fail later as a socket refusal naming a different" >&2
  echo "       cause (#97) — which has already cost one false-regression hunt." >&2
  exit 1
fi
echo "inserted"

echo ""
echo "== pg_notify payload cap (the reason the payload is an id, not the event) =="
# On a throwaway channel: the 8000-byte limit is a property of pg_notify itself,
# and using 'job_events' would make every relay listener parse it as an event id."
# pg_notify returns void, so it cannot be wrapped in length() — the question is
# only whether the call raises, and Postgres caps the payload at 8000 bytes.
for bytes in 7999 8000; do
  printf "  %s bytes: " "$bytes"
  out="$(docker exec "$PG" psql -U yggdrasil -d "$DB" -tAc \
    "do \$\$ begin perform pg_notify('relay_verify_cap_probe', repeat('x', $bytes)); end \$\$;" 2>&1)"
  if echo "$out" | grep -q ERROR; then
    echo "REJECTED → $(echo "$out" | grep -oE 'ERROR:.*' | head -1)"
  else
    echo "accepted"
  fi
done

echo ""
echo "== replica logs (both, so a startup failure is visible) =="
for c in "$A" "$B"; do
  echo "--- $c (last 20 lines) ---"
  docker logs "$c" 2>&1 | tail -20 | cut -c1-240 | sed 's/^/  /'
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    echo "  !! $c is NOT RUNNING (exit code $(docker inspect "$c" --format '{{.State.ExitCode}}' 2>/dev/null))"
  fi
done

echo ""
echo "== verification =="
docker run --rm --network "$NET" \
  -e INTERNAL_API_TOKEN="$TOKEN" \
  -e IDLE_SECONDS="$IDLE_SECONDS" \
  -v "$HERE/verify.cjs:/app/verify.cjs:ro" \
  "$IMAGE" node /app/verify.cjs
