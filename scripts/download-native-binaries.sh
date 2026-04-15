#!/usr/bin/env bash
set -euo pipefail

# Downloads signed native binaries (dylibs + ax-service) from argent-private-releases.
#
# Usage: ./scripts/download-native-binaries.sh <release-tag>
#   release-tag  Tag to download from (e.g. argent-v0.4.3). Required.
#
# Requires:
#   - gh CLI (no authentication needed — the repo is public)

REPO="software-mansion-labs/argent-private-releases"

if [[ -z "${1:-}" ]]; then
  echo "Error: release tag is required." >&2
  echo "Usage: $0 <release-tag>  (e.g. argent-v0.4.3)" >&2
  exit 1
fi

TAG="$1"

# Verify the release exists before attempting downloads.
if ! gh release view "${TAG}" --repo "${REPO}" &>/dev/null; then
  echo "Error: release '${TAG}' not found in ${REPO}." >&2
  echo "Build and publish the native binaries for this version first, then retry." >&2
  exit 1
fi
DYLIBS_DIR="packages/native-devtools-ios/dylibs"
BIN_DIR="packages/native-devtools-ios/bin"

echo "Downloading native binaries from ${REPO} (tag: ${TAG})..."

mkdir -p "${DYLIBS_DIR}" "${BIN_DIR}"

for DYLIB in libNativeDevtoolsIos.dylib libKeyboardPatch.dylib libArgentInjectionBootstrap.dylib; do
  echo "  Downloading ${DYLIB}..."
  gh release download "${TAG}" \
    --repo "${REPO}" \
    --pattern "${DYLIB}" \
    --dir "${DYLIBS_DIR}" \
    --clobber
done

echo "  Downloading ax-service..."
gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "ax-service" \
  --dir "${BIN_DIR}" \
  --clobber
chmod +x "${BIN_DIR}/ax-service"

echo "Downloaded native binaries to ${DYLIBS_DIR}/ and ${BIN_DIR}/"

if command -v codesign &>/dev/null; then
  for f in "${DYLIBS_DIR}"/*.dylib "${BIN_DIR}/ax-service"; do
    codesign -dvv "$f" 2>&1 || echo "Warning: signature verification failed for $f"
  done
fi
