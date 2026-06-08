#!/usr/bin/env bash
set -euo pipefail

# Downloads signed native binaries from argent-private-releases:
#   - iOS dylibs + ax-service
#   - Android argent-android-devtools.apk (helper APK consumed by
#     packages/native-devtools-android)
#
# The host-side Perfetto trace processor is no longer a native binary: it ships
# as a single ~13 MB `trace_processor.wasm` vendored into the repo
# (packages/native-devtools-android/assets/trace-processor/), so there is nothing
# to download for it here.
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
# ax-service is macOS-only (it spawns inside an iOS Simulator), so it lives
# under the darwin/ host-platform subdirectory — matching what
# axServiceBinaryPath() resolves (bin/<platform>/ax-service) and what
# packages/argent/scripts/bundle-tools.cjs copies into the published package
# (bin/darwin/ax-service). Writing it to the flat bin/ root instead silently
# drops it from every release: bundle-tools looks under darwin/, finds nothing,
# and skips the copy, so describe's ax-service path is unusable (regressed in
# the Linux-support layout migration, #249).
IOS_BIN_DIR="${BIN_DIR}/darwin"
ANDROID_BIN_DIR="packages/native-devtools-android/bin"
ANDROID_MANIFEST_FILE="packages/native-devtools-android/assets/manifest.json"

echo "Downloading native binaries from ${REPO} (tag: ${TAG})..."

mkdir -p "${DYLIBS_DIR}" "${BIN_DIR}" "${IOS_BIN_DIR}" "${ANDROID_BIN_DIR}"

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
  --dir "${IOS_BIN_DIR}" \
  --clobber
chmod +x "${IOS_BIN_DIR}/ax-service"

echo "  Downloading argent-android-devtools.apk..."
# The release publishes the APK under a stable name (no versioning in the
# filename) so this script doesn't have to know the version ahead of time;
# the local copy is renamed to match what manifest.json expects.
TMP_APK="$(mktemp -t argent-android-devtools.XXXXXX.apk)"
trap 'rm -f "$TMP_APK"' EXIT
gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "argent-android-devtools.apk" \
  --output "${TMP_APK}" \
  --clobber

# Read the versionName from the local manifest so the filename matches
# bundledHelperApkPath()'s expectation.
ANDROID_VERSION_NAME="$(node -p "require('$PWD/${ANDROID_MANIFEST_FILE}').versionName")"
ANDROID_TARGET="${ANDROID_BIN_DIR}/argent-android-devtools-${ANDROID_VERSION_NAME}.apk"
mv -f "${TMP_APK}" "${ANDROID_TARGET}"
trap - EXIT

echo "Downloaded native binaries to ${DYLIBS_DIR}/, ${IOS_BIN_DIR}/, and ${ANDROID_BIN_DIR}/"

if command -v codesign &>/dev/null; then
  for f in "${DYLIBS_DIR}"/*.dylib "${IOS_BIN_DIR}/ax-service"; do
    codesign -dvv "$f" 2>&1 || echo "Warning: signature verification failed for $f"
  done
fi

if command -v "${ANDROID_HOME:-${HOME}/Library/Android/sdk}/build-tools/36.0.0/apksigner" &>/dev/null; then
  "${ANDROID_HOME:-${HOME}/Library/Android/sdk}/build-tools/36.0.0/apksigner" verify --verbose "${ANDROID_TARGET}" 2>&1 \
    || echo "Warning: APK signature verification failed"
fi
