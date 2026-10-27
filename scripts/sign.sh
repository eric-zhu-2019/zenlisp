#!/bin/bash
# Signs a built ZParen.app with a Developer ID and packs it into a signed disk
# image. It runs no build tools or packages, so CI hands the certificate to
# this script alone.
# Usage: ZPAREN_SIGN_IDENTITY=<identity> scripts/sign.sh path/to/ZParen.app out.dmg
set -euo pipefail
app=$1 dmg=$2
id=${ZPAREN_SIGN_IDENTITY:?set ZPAREN_SIGN_IDENTITY to a Developer ID Application identity}
entitlements="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/sbcl.entitlements"
sign() { codesign --force --options runtime --timestamp --sign "$id" "$@"; }

# Code inside Resources is not signed with the bundle, so it goes first.
sbcl="$app/Contents/Resources/sbcl"
for lib in "$sbcl/lib/"*.dylib; do
  if [ -e "$lib" ]; then sign "$lib"; fi
done
if [ -e "$sbcl/bin/sbcl" ]; then sign --entitlements "$entitlements" "$sbcl/bin/sbcl"; fi
sign "$app"
codesign --verify --deep --strict "$app"

stage=$(mktemp -d)
ditto "$app" "$stage/$(basename "$app")"
ln -s /Applications "$stage/Applications"
hdiutil create -quiet -volname ZParen -srcfolder "$stage" -format UDZO -ov "$dmg"
codesign --force --timestamp --sign "$id" "$dmg"
codesign --verify --strict "$dmg"
echo "== signed $dmg"
