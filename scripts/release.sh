#!/bin/bash
# Builds ZParen.app and its disk image signed with a Developer ID, checks the
# signatures, and notarizes when given a notarytool profile.
#
#   ZPAREN_SIGN_IDENTITY   "Developer ID Application: …" or its SHA-1 (required)
#   NOTARY_PROFILE         a profile saved with `xcrun notarytool store-credentials` (optional)
#
# Updates (all optional, all or none): the app checks ZPAREN_UPDATE_URL for a
# latest.json, and installs only archives signed with the key whose public half
# is ZPAREN_UPDATE_PUBKEY (from `npx tauri signer generate`).
#   ZPAREN_UPDATE_URL            where latest.json will be published
#   ZPAREN_UPDATE_PUBKEY         the update key's public half
#   ZPAREN_UPDATE_DOWNLOAD       the URL the update archive will be published at
#   TAURI_SIGNING_PRIVATE_KEY    the private half (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD)
#   ZPAREN_UPDATE_INSECURE=1     allow an http:// source, for testing against a local server
set -euo pipefail
cd "$(dirname "$0")/.."

# The names from when ZParen was ZenLisp still work.
for v in SIGN_IDENTITY UPDATE_URL UPDATE_PUBKEY UPDATE_DOWNLOAD UPDATE_INSECURE; do
  old=ZENLISP_$v new=ZPAREN_$v
  if [ -z "${!new:-}" ] && [ -n "${!old:-}" ]; then export "$new=${!old}"; fi
done

: "${ZPAREN_SIGN_IDENTITY:?set ZPAREN_SIGN_IDENTITY to a Developer ID Application identity (security find-identity -v -p codesigning)}"
export ZPAREN_SIGN_IDENTITY
export APPLE_SIGNING_IDENTITY="$ZPAREN_SIGN_IDENTITY"

config=()
if [ -n "${ZPAREN_UPDATE_URL:-}" ]; then
  : "${ZPAREN_UPDATE_PUBKEY:?updates need ZPAREN_UPDATE_PUBKEY}" "${ZPAREN_UPDATE_DOWNLOAD:?updates need ZPAREN_UPDATE_DOWNLOAD}"
  : "${TAURI_SIGNING_PRIVATE_KEY:?updates need TAURI_SIGNING_PRIVATE_KEY to sign the archive}"
  config=(--config "$(python3 -c 'import json,os; print(json.dumps({"bundle": {"createUpdaterArtifacts": True}, "plugins": {"updater": {"pubkey": os.environ["ZPAREN_UPDATE_PUBKEY"], "endpoints": [os.environ["ZPAREN_UPDATE_URL"]], "dangerousInsecureTransportProtocol": os.environ.get("ZPAREN_UPDATE_INSECURE") == "1"}}}))')")
fi

npx tauri build --bundles app,dmg ${config[@]+"${config[@]}"}

app=target/release/bundle/macos/ZParen.app
dmg=$(ls -t target/release/bundle/dmg/*.dmg | head -1)

echo "== checking signatures"
codesign --verify --deep --strict --verbose=2 "$app"
codesign -dv --verbose=2 "$app/Contents/Resources/sbcl/bin/sbcl" 2>&1 | grep -E "Authority=Developer ID|flags=.*runtime" || {
  echo "the bundled sbcl is not signed for distribution" >&2
  exit 1
}

if [ -n "${ZPAREN_UPDATE_URL:-}" ]; then
  archive=target/release/bundle/macos/ZParen.app.tar.gz
  version=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$app/Contents/Info.plist")
  ARCHIVE_SIG="$(cat "$archive.sig")" VERSION="$version" python3 - > target/release/bundle/latest.json <<'PY'
import json, os, datetime
print(json.dumps({
    "version": os.environ["VERSION"],
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "platforms": {"darwin-aarch64": {"signature": os.environ["ARCHIVE_SIG"], "url": os.environ["ZPAREN_UPDATE_DOWNLOAD"]}},
}, indent=2))
PY
  echo "== update: publish $archive at $ZPAREN_UPDATE_DOWNLOAD and target/release/bundle/latest.json at $ZPAREN_UPDATE_URL"
fi

if [ -z "${NOTARY_PROFILE:-}" ]; then
  echo "== signed, not notarized: set NOTARY_PROFILE to notarize"
  echo "   $app"
  echo "   $dmg"
  exit 0
fi

echo "== notarizing $dmg"
xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$dmg"
xcrun stapler staple "$app"
spctl --assess --type execute --verbose=2 "$app"
echo "== notarized: $dmg"
