#!/usr/bin/env bash
set -euo pipefail

# Downloads the SIGNED ios-profiler host binaries (ios-profiler-capture,
# ios-profiler-mem) from argent-private-releases into the package's bin/darwin/,
# so @argent/ios-profiling runs the real signed artifact without a full npm
# release. This is the local-testing seam: pair it with the package's build.sh
# PREBUILT_IOS_PROFILER_BIN_DIR hook, or just drop the binaries straight in.
#
# The binaries are built + Developer-ID-signed (hardened runtime + entitlements)
# by argent-private's build-native-binaries.yml and published as release assets
# alongside the dylibs/ax-service under the same tag.
#
# Usage: ./scripts/download-ios-profiler.sh [release-tag]
#   release-tag  Tag to download from. Defaults to argent-main.
#                Use argent-daily for the prerelease (workflow_dispatch with
#                prerelease=true) dev loop.
#
# Requires:
#   - gh CLI (no authentication needed — the releases repo is public)

REPO="software-mansion/argent-private-releases"
TAG="${1:-argent-main}"
DEST="packages/argent-ios-profiling/bin/darwin"

if ! gh release view "${TAG}" --repo "${REPO}" &>/dev/null; then
  echo "Error: release '${TAG}' not found in ${REPO}." >&2
  echo "Build and publish the ios-profiler binaries for this tag first, then retry." >&2
  exit 1
fi

mkdir -p "${DEST}"

for b in ios-profiler-capture ios-profiler-mem; do
  echo "  Downloading ${b}..."
  if ! gh release download "${TAG}" \
    --repo "${REPO}" \
    --pattern "${b}" \
    --dir "${DEST}" \
    --clobber; then
    echo "Error: '${b}' not found in release '${TAG}'." >&2
    echo "The signing pipeline may not have shipped it for this tag yet." >&2
    exit 1
  fi
  chmod +x "${DEST}/${b}"
done

echo "Downloaded signed ios-profiler binaries to ${DEST}/"

if command -v codesign &>/dev/null; then
  for b in ios-profiler-capture ios-profiler-mem; do
    codesign -dvv "${DEST}/${b}" 2>&1 || echo "Warning: signature verification failed for ${b}"
  done
fi
