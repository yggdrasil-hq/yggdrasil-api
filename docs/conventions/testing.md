# Convention: running the test suite

**Read this when:** you run this repo's tests, a case skipped, or a change needs
verifying against a real database or MinIO.

## The two ways

**1. The compose run — the default, and what CI uses.**

```bash
docker compose -f docker-compose.test.yml up --build --abort-on-container-exit --exit-code-from test
```

It brings up its own Postgres and MinIO, runs `tsc --noEmit`, then vitest.

`--build` is needed when the **image** has to change: the first run, a
`package.json`/lockfile edit, or a new top-level source directory. It is **not**
needed for an edit under the mounted paths — issue #102 mounts the source
read-only, so a run always sees the tree on disk. Before that it did not, and
running without `--build` silently tested the previous build: that produced a false
pass, and a false *negative* on a mutation, which is the more expensive direction.
`scripts/run-tests.sh` prints a "source under test" digest so the tree a run
actually saw is visible in its log.

**2. Against a real database, converting the skipped cases into real checks.**

```bash
./scripts/test-against-real-db.sh
```

Ten files verify against a real PostgreSQL and **skip** in full when they cannot
reach one — they print what went unverified. In the compose run on this project's
dev host, **77 tests skip**, so "the suite is green" means less than it appears to.
This script drops that to **10**, and the **67** it recovers are precisely the ones
guarding #43, #56, #61, #75, #76 and #31 — real-database bugs that a green suite
did not catch.

**Both numbers are measured and environment-dependent** (issue #105): they count the
cases that cannot reach a database from wherever the suite is running, so a host
that *can* reach one skips fewer and has less for the script to recover. The same
invocation in CI reports `103 passed (103)` files and `1550 passed (1550)` tests —
**zero skips**, because GitHub's runners reach both services. The dev-host 77 is
that host's number, not a property of the suite; it is what makes this script worth
running, and it is also why a figure quoted here without naming its environment is
misleading. They are quoted with their recipe rather than as a constant:

```bash
docker compose -f docker-compose.test.yml up --build \
  --abort-on-container-exit --exit-code-from test | tail -3   # "... | 77 skipped" here, 0 in CI
./scripts/test-against-real-db.sh                            # reports "... | 10 skipped"
```

**A run's own summary line is the authority for a skip count, not this file.** The
figure here read 29 for several waves after the truth had moved to 77, because a
number in prose has nothing to fail when it drifts — and the script's closing
message now reports what it observed rather than repeating one.

## Why skipping is deliberate, and why it is not a pass

These cases are **never mocked**, on purpose. A fake `pg` pool has no opinion on
whether Postgres *accepts* a statement, which is how this repo shipped several
bugs behind a passing suite:

| Bug | What the fake pool could not see |
|---|---|
| #43 | a repository method that threw `42P08` on **every** call |
| #61 | an audit query ambiguous against a joined table, so the page always 500'd |
| #56 | four endpoints registered at paths the app never served |
| #75 | a declaration disagreeing with the column's `CHECK` |
| #76 | two migrators racing, where the loser dies at startup |

A mock would have agreed with the code by construction in every one of those. So a
skipped case is an honest gap, and the warning names it — **but it is still a gap.**
If you are verifying a change that touches SQL, run option 2 or the matching
`scripts/verify/*.mts`, and say in your report which you ran.

## The 10 that stay skipped

The MinIO contract cases (`src/storage/client.test.ts`) need a reachable MinIO.
The dev stack's MinIO publishes no host port, so `--network host` does not reach it
either. `scripts/verify/issue-30-object-storage.mts` is the standalone check.

## `scripts/verify/*.mts`

One standalone script per bug whose verification needs a real database or service.
They are the reproducible half of an issue's fix: each applies migrations, asserts
against real infrastructure, and cleans up its own rows. Run one with the pattern
in its header comment — several of them also explain why the case is not mocked.

## Two traps worth knowing

**A skip can hide a wiring bug.** If your change makes a case *unreachable* rather
than *failing*, the run stays green. Both the compose network and the dev database
are reachable here, so a skip you did not expect is worth explaining.

**`docker compose run test` does not rebuild the image.** Only `test-results/` is a
volume, so the app code inside the container is the one baked at its last build —
an edit you just made is not in there. Use `up --build`, or pass `--build` to
`docker compose run`. `docker run` has no such flag, so a bare `docker run
<image>` always tests whatever that image was built from.
