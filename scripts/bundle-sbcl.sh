#!/bin/bash
# Copies the installed SBCL into src-tauri/sbcl, for the app to carry when the
# Mac it runs on has none: the runtime, its zstd library (made relative so it
# needs no Homebrew), the core and the contribs, and their licenses.
set -euo pipefail
cd "$(dirname "$0")/.."

out=src-tauri/sbcl
prefix=$(brew --prefix sbcl 2>/dev/null || true)
if [ -z "$prefix" ] || [ ! -d "$prefix" ]; then
  echo "bundle-sbcl: no Homebrew SBCL; the app will use the SBCL it finds when it runs" >&2
  rm -rf "$out" && mkdir -p "$out"
  exit 0
fi
cellar=$(cd "$prefix" && pwd -P)
# ZPAREN_SIGN_IDENTITY signs the bundle for distribution; without it, an ad hoc signature runs locally.
identity=${ZPAREN_SIGN_IDENTITY:--}
stamp="$(basename "$cellar") signed:$identity"
if [ -f "$out/VERSION" ] && [ "$(cat "$out/VERSION")" = "$stamp" ]; then
  exit 0
fi

rm -rf "$out"
mkdir -p "$out/bin" "$out/lib"
cp "$cellar/libexec/bin/sbcl" "$out/bin/sbcl"
cp -R "$cellar/lib/sbcl" "$out/lib/sbcl"
rm -f "$out/lib/sbcl/sbclrc"
# Homebrew's files are read-only, and signing the app needs to clear their attributes.
chmod -R u+w "$out"

zstd=$(otool -L "$out/bin/sbcl" | awk '/libzstd/ {print $1}')
if [ -n "$zstd" ]; then
  cp "$(cd "$(dirname "$zstd")" && pwd -P)/$(basename "$zstd")" "$out/lib/"
  chmod u+w "$out/lib/$(basename "$zstd")"
  install_name_tool -id "@loader_path/../lib/$(basename "$zstd")" "$out/lib/$(basename "$zstd")"
  install_name_tool -change "$zstd" "@executable_path/../lib/$(basename "$zstd")" "$out/bin/sbcl"
fi
# Changing load paths breaks the signatures, and arm64 Macs refuse unsigned code.
# Notarization needs the hardened runtime and a timestamp, and SBCL its entitlements.
if [ "$identity" = "-" ]; then
  codesign --force --sign - "$out/lib/"*.dylib "$out/bin/sbcl" 2>/dev/null
else
  codesign --force --options runtime --timestamp --sign "$identity" "$out/lib/"*.dylib
  codesign --force --options runtime --timestamp --entitlements src-tauri/sbcl.entitlements --sign "$identity" "$out/bin/sbcl"
fi

zstd_prefix=$(brew --prefix zstd 2>/dev/null || true)
cp "$cellar/COPYING" "$out/SBCL-COPYING" 2>/dev/null || cp "$cellar/share/doc/sbcl/COPYING" "$out/SBCL-COPYING" 2>/dev/null || true
[ -n "$zstd_prefix" ] && cp "$zstd_prefix/LICENSE" "$out/ZSTD-LICENSE" 2>/dev/null || true
echo "$stamp" > "$out/VERSION"

SBCL_HOME="$out/lib/sbcl" "$out/bin/sbcl" --noinform --non-interactive --no-userinit \
  --eval '(require :sb-introspect)' --eval '(format t "bundle-sbcl: SBCL ~a bundled~%" (lisp-implementation-version))'
