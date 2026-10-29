#!/bin/sh
# Xcode assembles the runner app from its own template after the test target's
# build phases, so its name and icon are set here and the signature re-sealed.
set -eu

runner="$BUILT_PRODUCTS_DIR/ArgentRunnerUITests-Runner.app"
tests="$runner/PlugIns/ArgentRunnerUITests.xctest"

cp "$tests/Assets.car" "$tests/AppIcon60x60@2x.png" "$runner/"
plutil -replace CFBundleDisplayName -string "Argent Runner" "$runner/Info.plist"
plutil -replace CFBundleIcons -json "$(plutil -extract CFBundleIcons json -o - "$tests/Info.plist")" "$runner/Info.plist"

# Only a bundle Xcode signed has a seal; the template executable carries
# Apple's own signature even in an unsigned build.
[ -d "$runner/_CodeSignature" ] || exit 0

if codesign -dvv "$runner" 2>&1 | grep -q '^Signature=adhoc'; then
  identity=-
else
  rm -f "$TARGET_TEMP_DIR/runner-cert"*
  mkdir -p "$TARGET_TEMP_DIR"
  codesign -d --extract-certificates="$TARGET_TEMP_DIR/runner-cert" "$runner"
  identity=$(shasum -a 1 < "$TARGET_TEMP_DIR/runner-cert0" | cut -d ' ' -f 1)
fi

codesign --force --sign "$identity" --timestamp=none --generate-entitlement-der \
  --preserve-metadata=entitlements,requirements,flags "$runner"
