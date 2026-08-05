#!/usr/bin/env bash
# Runs every scripts/test-*.js file (Node-only static/vm-sandbox tests and
# the Playwright real-browser test alike) in sequence, printing a pass/fail
# summary at the end. Used by `npm test` and intended to be the single
# command CI runs.
#
# Prerequisites:
#   npm ci
#   npx playwright install chromium   # only needed once per machine/image;
#                                       # skip if PLAYWRIGHT_BROWSERS_PATH
#                                       # already points at a pre-installed
#                                       # Chromium (see scripts/test-help-
#                                       # dropdown-visibility.js's own header
#                                       # comment).
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
failed_files=()

for f in scripts/test-*.js; do
  echo "=== $f ==="
  if node "$f"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failed_files+=("$f")
  fi
  echo
done

echo "============================================"
echo "$pass passed, $fail failed (of $((pass + fail)) test files)"
if [ "$fail" -gt 0 ]; then
  echo "Failed:"
  for f in "${failed_files[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
