#!/usr/bin/env bash
set -euo pipefail

# Downloads the signed simulator-server (argent variant) for every supported
# host platform from simulator-server-releases, into platform-keyed
# subdirectories under packages/native-devtools-ios/bin/. The bundle step
# (packages/argent/scripts/bundle-tools.cjs) and the runtime resolver in
# @argent/native-devtools-ios both expect this layout.
#
# Usage: ./scripts/download-simulator-server.sh [release-tag]
#   release-tag  Optional tag to download from. Defaults to radon-main.
#
# Requires:
#   - gh CLI (no authentication needed — the repo is public)

REPO="software-mansion-labs/simulator-server-releases"
TAG="${1:-radon-main}"
DEST_DIR="packages/native-devtools-ios/bin"

# release-asset-name → process.platform key. Asset names follow the upstream
# build matrix (`simulator-server-argent-{macos,linux}`); the keys mirror
# Node's process.platform so the resolver can lookup by host platform.
declare -a TARGETS=(
  "simulator-server-argent-macos:darwin"
  "simulator-server-argent-linux:linux"
)

mkdir -p "${DEST_DIR}"

for entry in "${TARGETS[@]}"; do
  ASSET_NAME="${entry%%:*}"
  PLATFORM="${entry##*:}"
  PLATFORM_DIR="${DEST_DIR}/${PLATFORM}"
  mkdir -p "${PLATFORM_DIR}"

  echo "Downloading ${ASSET_NAME} → ${PLATFORM_DIR}/simulator-server"
  # The Linux artifact comes from radon's separate `build_argent_simulator_
  # server_linux` job, which is independent of the macOS release. Tolerate it
  # being absent (e.g. on releases produced before that job landed) so this
  # script keeps working for macOS-only consumers in the meantime.
  if ! gh release download "${TAG}" \
       --repo "${REPO}" \
       --pattern "${ASSET_NAME}" \
       --dir "${PLATFORM_DIR}" \
       --clobber 2>/dev/null; then
    echo "  ⚠ ${ASSET_NAME} not present on ${TAG} — skipping (binary won't be available on ${PLATFORM} hosts)"
    rmdir "${PLATFORM_DIR}" 2>/dev/null || true
    continue
  fi

  mv "${PLATFORM_DIR}/${ASSET_NAME}" "${PLATFORM_DIR}/simulator-server"
  chmod +x "${PLATFORM_DIR}/simulator-server"
done

echo ""
echo "Downloaded simulator-server binaries:"
find "${DEST_DIR}" -name simulator-server -type f -exec ls -la {} \;

# Only the macOS binary is signed and codesignable; the Linux ELF doesn't
# carry an Apple signature, and `codesign` would noisily fail on it.
if command -v codesign &>/dev/null && [[ -f "${DEST_DIR}/darwin/simulator-server" ]]; then
  codesign -dvv "${DEST_DIR}/darwin/simulator-server" 2>&1 \
    || echo "Warning: macOS signature verification failed"
fi
