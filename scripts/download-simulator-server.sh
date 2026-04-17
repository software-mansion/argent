#!/usr/bin/env bash
set -euo pipefail

# Downloads the signed simulator-server (argent variant) from simulator-server-releases.
#
# Usage: ./scripts/download-simulator-server.sh [release-tag]
#   release-tag  Optional tag to download from. If omitted, downloads the latest stable release.
#
# Requires:
#   - gh CLI (no authentication needed — the repo is public)

REPO="software-mansion-labs/simulator-server-releases"
TAG="${1:-radon-main}"
ASSET_NAME="simulator-server-argent-macos"
DEST_DIR="packages/native-devtools-ios/bin"
DEST_PATH="${DEST_DIR}/simulator-server"

TAG_ARGS=()
echo "Downloading ${ASSET_NAME} from ${REPO} (tag: ${TAG})..."

mkdir -p "${DEST_DIR}"

gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "${ASSET_NAME}" \
  --dir "${DEST_DIR}" \
  --clobber

mv "${DEST_DIR}/${ASSET_NAME}" "${DEST_PATH}"
chmod +x "${DEST_PATH}"

echo "Downloaded simulator-server to ${DEST_PATH}"

if command -v codesign &>/dev/null; then
  codesign -dvv "${DEST_PATH}" 2>&1 || echo "Warning: signature verification failed"
fi
