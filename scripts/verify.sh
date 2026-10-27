#!/bin/bash
# Runs every ZParen check and exits non-zero on the first failure. Each
# SBCL-backed test binary gets a hard time limit, because a Swank request that
# never returns hangs forever otherwise.
# Usage: scripts/verify.sh [--network]   (--network adds tests that need ghcr.io)
set -euo pipefail
cd "$(dirname "$0")/.."
limit() { perl -e 'alarm shift; exec @ARGV' "$@"; }
extra=()
# The tests' Lisps use none of the user's folders: no plugins, settings or
# saved conversations of theirs are read, changed or moved.
export ZPAREN_CONFIG_DIR=$(mktemp -d) ZPAREN_DATA_DIR=$(mktemp -d)
[ "${1:-}" = "--network" ] && extra=(--include-ignored)
# The app build lists the bundled SBCL folder, which a fresh checkout lacks.
mkdir -p src-tauri/sbcl

echo "== rust"
bins=$(cargo test --workspace --no-run --message-format=json 2>/dev/null \
  | python3 -c 'import sys,json
for l in sys.stdin:
    m=json.loads(l)
    if m.get("reason")=="compiler-artifact" and m.get("profile",{}).get("test") and m.get("executable"):
        print(m["executable"])')
for b in $bins; do
  printf '%s: ' "$(basename "$b")"
  if ! out=$(limit 300 "$b" -q ${extra[@]+"${extra[@]}"} 2>&1); then
    echo "FAILED"
    echo "$out" | tail -30
    exit 1
  fi
  echo "$out" | grep "test result"
done
git checkout -q -- src/protocol 2>/dev/null || true
cargo test -q -p zparen-core export_bindings >/dev/null

echo "== parinfer wasm"
(cd crates/parinfer-wasm && cargo test -q)

echo "== typescript"
npx tsc --noEmit -p .
npx vitest run

echo "== end to end"
npx playwright test --reporter=line
echo "== all checks passed"
