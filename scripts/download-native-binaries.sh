#!/usr/bin/env bash
set -euo pipefail

# Downloads signed native binaries (iOS dylibs + ax-service + Android
# trace_processor_shell) from argent-private-releases.
#
# Usage: ./scripts/download-native-binaries.sh [release-tag]
#   release-tag  Tag to download from (e.g. argent-v0.5.3). Defaults to argent-main.
#
# Requires:
#   - gh CLI (no authentication needed — the repo is public)

REPO="software-mansion-labs/argent-private-releases"

TAG="${1:-argent-main}"

# Verify the release exists before attempting downloads.
if ! gh release view "${TAG}" --repo "${REPO}" &>/dev/null; then
  echo "Error: release '${TAG}' not found in ${REPO}." >&2
  echo "Build and publish the native binaries for this version first, then retry." >&2
  exit 1
fi
DYLIBS_DIR="packages/native-devtools-ios/dylibs"
BIN_DIR="packages/native-devtools-ios/bin"
ANDROID_BIN_DIR="packages/native-devtools-android/bin"

# Map `uname -s -m` to the platform suffix used by argent-private's
# build-native-binaries.yml workflow. Keep this case-switch in sync with the
# `for PLATFORM in …` loop in that workflow.
UNAME_S="$(uname -s)"
UNAME_M="$(uname -m)"
case "${UNAME_S}-${UNAME_M}" in
  Darwin-arm64)              HOST_PLATFORM="mac-arm64" ;;
  Darwin-x86_64)             HOST_PLATFORM="mac-amd64" ;;
  Linux-x86_64)              HOST_PLATFORM="linux-amd64" ;;
  Linux-aarch64|Linux-arm64) HOST_PLATFORM="linux-arm64" ;;
  *)
    echo "Error: unsupported host platform '${UNAME_S} ${UNAME_M}'." >&2
    echo "argent ships trace_processor_shell for: mac-arm64, mac-amd64, linux-amd64, linux-arm64." >&2
    exit 1
    ;;
esac

echo "Downloading native binaries from ${REPO} (tag: ${TAG}, host: ${HOST_PLATFORM})..."

mkdir -p "${DYLIBS_DIR}" "${BIN_DIR}" "${ANDROID_BIN_DIR}"

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

# Pull the host-matching trace_processor_shell variant and rename it to the
# canonical bundler-expected filename. The release publishes one binary per
# supported host (see argent-private/.github/workflows/build-native-binaries.yml);
# we only need the one for whoever's packing.
TP_ASSET="trace_processor_shell-${HOST_PLATFORM}"
echo "  Downloading ${TP_ASSET}..."
gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "${TP_ASSET}" \
  --dir "${ANDROID_BIN_DIR}" \
  --clobber
mv "${ANDROID_BIN_DIR}/${TP_ASSET}" "${ANDROID_BIN_DIR}/trace_processor_shell"
chmod +x "${ANDROID_BIN_DIR}/trace_processor_shell"

echo "Downloaded native binaries to ${DYLIBS_DIR}/, ${BIN_DIR}/, and ${ANDROID_BIN_DIR}/"

if command -v codesign &>/dev/null; then
  for f in "${DYLIBS_DIR}"/*.dylib "${BIN_DIR}/ax-service"; do
    codesign -dvv "$f" 2>&1 || echo "Warning: signature verification failed for $f"
  done
fi
