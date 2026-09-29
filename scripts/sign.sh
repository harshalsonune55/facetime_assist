#!/bin/bash
# electron-builder cannot sign in place here: ~/Documents is iCloud-synced, and
# the file provider keeps stamping com.apple.FinderInfo onto the bundle root,
# which codesign rejects as "detritus". Auto-discovery also picks the Apple
# Development cert, which fails unattended - so build unsigned, then ad-hoc sign
# a copy staged outside the synced tree.
set -euo pipefail

SRC="${1:-dist/mac-arm64/Clue.app}"
STAGE="${TMPDIR:-/tmp}/clue-stage"

rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto --norsrc --noextattr --noacl "$SRC" "$STAGE/Clue.app"
APP="$STAGE/Clue.app"
xattr -cr "$APP"

# Bottom-up: nested frameworks, then helper apps, then the outer bundle.
for fw in "$APP/Contents/Frameworks/"*.framework; do codesign --force --sign - "$fw"; done
for helper in "$APP/Contents/Frameworks/"*.app; do codesign --force --sign - "$helper"; done
codesign --force --sign - "$APP"

codesign --verify --strict --deep "$APP"
echo "signed and verified: $APP"
