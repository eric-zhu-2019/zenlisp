#!/bin/sh
# Copies the Swank server (from SLIME, public domain) into resources/swank.
# Usage: scripts/vendor-swank.sh [slime-source-dir]
set -eu
src=${1:-$(ls -d "$HOME"/.quicklisp/dists/quicklisp/software/slime-v* | sort -V | tail -1)}
dst=$(cd "$(dirname "$0")/.." && pwd)/resources/swank
rm -rf "$dst"
mkdir -p "$dst/swank" "$dst/contrib"
cp "$src"/swank-loader.lisp "$src"/swank.lisp "$src"/swank.asd "$src"/packages.lisp \
   "$src"/metering.lisp "$src"/nregex.lisp "$src"/xref.lisp "$src"/README.md "$dst"/
cp "$src"/swank/*.lisp "$dst"/swank/
cp "$src"/contrib/swank-*.lisp "$dst"/contrib/
basename "$src" > "$dst"/VERSION
echo "vendored $(cat "$dst"/VERSION) into $dst"
