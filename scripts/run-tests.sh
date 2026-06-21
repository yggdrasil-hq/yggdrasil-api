#!/usr/bin/env sh
set -eu

mkdir -p test-results

npx vitest run --reporter=default --reporter=json --outputFile=test-results/vitest.json
status=$?

node scripts/github-actions-test-summary.mjs test-results/vitest.json

exit "$status"
