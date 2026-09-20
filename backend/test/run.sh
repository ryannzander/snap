#!/usr/bin/env bash
#
# Compiles the suites out to plain JS and runs them on Node.
#
# There is no test runner in the dependency tree on purpose: the Worker is the
# only thing that needs a bundler, and every module under test here is a pure
# function. tsc emits extensionless relative imports (the bundler resolution
# the Worker build uses), which Node will not resolve, so they get an
# extension added on the way out.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=".test-out"
rm -rf "$OUT"

if ! npx tsc -p test/tsconfig.json; then
  echo "  compile failed" >&2
  exit 1
fi

# './guards'  ->  './guards.js'   (leaving alone any that already have one)
find "$OUT" -name '*.js' -print0 | xargs -0 sed -i -E \
  -e "s@(from '\\.{1,2}/[^']*)'@\\1.js'@g" \
  -e "s@\\.js\\.js'@.js'@g"

status=0
for f in "$OUT"/test/*.test.js; do
  node "$f" || status=1
done

if [ "$status" -eq 0 ]; then
  echo "  all suites pass"
else
  echo "  SUITE FAILURES" >&2
fi
exit "$status"
