#!/bin/sh
# Builds crates/parinfer-wasm into src/editor/parinfer/pkg, which is committed so the
# app builds without a wasm toolchain. Needs wasm-pack and the wasm32-unknown-unknown target.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/src/editor/parinfer/pkg"
wasm-pack build "$root/crates/parinfer-wasm" --release --target web --no-pack --out-dir "$out"
# wasm-pack writes an ignore-everything file into the output; the pkg is meant to be committed.
rm -f "$out/.gitignore"
echo "built parinfer wasm into $out"
