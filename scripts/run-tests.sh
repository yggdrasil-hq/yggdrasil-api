#!/usr/bin/env sh
set -eu

mkdir -p test-results

# Issue #102: state which tree this run is looking at.
#
# `docker-compose.test.yml` mounts the source read-only, so an edit is always what
# runs — this prints the note that lets a reader of a log *confirm* that. It
# answers the one question a test log otherwise cannot: did this run see the change
# that was just made, or a build from before it? A digest, because the identity of
# a tree should be comparable between runs — including a run in CI, where nobody is
# watching and the log is read later.
#
# Guarded with `command -v` and a fallback, and every substitution is `|| echo`-safe,
# because a reporting line must never be able to fail the suite it is reporting on.
SOURCE_DIRS="src"
if command -v sha256sum >/dev/null 2>&1; then
  source_files=$(find $SOURCE_DIRS -type f 2>/dev/null | wc -l | tr -d ' ' || echo '?')
  source_newest=$(find $SOURCE_DIRS -type f -printf '%TY-%Tm-%TdT%TH:%TM:%TS\n' 2>/dev/null | sort | tail -1 | cut -c1-19 || echo '?')
  source_digest=$(find $SOURCE_DIRS -type f -exec sha256sum {} + 2>/dev/null | sort | sha256sum | cut -c1-12 || echo '?')
  echo "== source under test: $source_files file(s) in '$SOURCE_DIRS', newest $source_newest, sha256 $source_digest"
else
  echo "== source under test: digest unavailable (no sha256sum in this image)"
fi

npx tsc --noEmit

npx vitest run --reporter=default --reporter=json --outputFile=test-results/vitest.json
status=$?

node scripts/github-actions-test-summary.mjs test-results/vitest.json

exit "$status"
