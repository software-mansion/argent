#!/usr/bin/env bash
set -euo pipefail

# Downloads simulator-server (argent variant) for every supported host platform
# into platform-keyed subdirectories of packages/native-devtools-ios/bin/ — the
# layout packages/argent/scripts/bundle-tools.cjs and the runtime resolver in
# @argent/native-devtools-ios both expect.
#
# Usage: ./scripts/download-simulator-server.sh [release-tag]
#
# Requires an authenticated gh CLI: the release repo is public, but
# `gh release download` still needs auth.

REPO="software-mansion-labs/simulator-server-releases"
TAG="${1:-radon-main}"
DEST_DIR="packages/native-devtools-ios/bin"

# release-asset-name → host platform key; the keys mirror hostPlatformKey() in
# @argent/native-devtools-ios so the resolver can look up by host.
declare -a TARGETS=(
  "simulator-server-argent-macos:darwin"
  "simulator-server-argent-linux:linux"
  "simulator-server-argent-linux-arm64:linux-arm64"
  "simulator-server-argent-windows.exe:win32"
)

mkdir -p "${DEST_DIR}"

for entry in "${TARGETS[@]}"; do
  ASSET_NAME="${entry%%:*}"
  PLATFORM="${entry##*:}"
  PLATFORM_DIR="${DEST_DIR}/${PLATFORM}"
  # Must match simulatorServerBinaryName() in the resolver and the dispatcher.
  if [[ "${PLATFORM}" == "win32" ]]; then
    BIN_BASENAME="simulator-server.exe"
  else
    BIN_BASENAME="simulator-server"
  fi

  # Purge first so a previous run's stale binary can't ship when this run's
  # download fails and the branch below only warns and continues.
  rm -rf "${PLATFORM_DIR}"
  mkdir -p "${PLATFORM_DIR}"

  echo "Downloading ${ASSET_NAME} → ${PLATFORM_DIR}/${BIN_BASENAME}"
  # Tolerate missing assets so macOS-only consumers still work when another
  # platform's artifact lags a release. Capture gh's stderr rather than
  # discarding it: "not authenticated" vs "asset missing" vs "rate-limited".
  GH_STDERR="$(mktemp)"
  if ! gh release download "${TAG}" \
       --repo "${REPO}" \
       --pattern "${ASSET_NAME}" \
       --dir "${PLATFORM_DIR}" \
       --clobber 2>"${GH_STDERR}"; then
    GH_MSG=$(<"${GH_STDERR}")
    rm -f "${GH_STDERR}"
    echo "  ⚠ ${ASSET_NAME} not downloaded — skipping (binary won't be available on ${PLATFORM} hosts)"
    [[ -n "${GH_MSG}" ]] && printf '    gh: %s\n' "${GH_MSG//$'\n'/$'\n    gh: '}"
    # Empty (purged above), so the dir disappears and the inventory stays clean.
    rmdir "${PLATFORM_DIR}" 2>/dev/null || true
    continue
  fi
  rm -f "${GH_STDERR}"

  mv "${PLATFORM_DIR}/${ASSET_NAME}" "${PLATFORM_DIR}/${BIN_BASENAME}"
  chmod +x "${PLATFORM_DIR}/${BIN_BASENAME}"

  # A wrong-arch binary is worse than a missing one: the resolver picks it and
  # the user gets ENOEXEC at spawn with no hint. Fail hard here, unlike the
  # missing-asset case, because a mislabeled asset is an upstream packaging bug.
  if command -v file >/dev/null 2>&1; then
    DESC="$(file -b "${PLATFORM_DIR}/${BIN_BASENAME}")"
    case "${PLATFORM}" in
      darwin) EXPECT="Mach-O universal" ;;
      linux) EXPECT="ELF 64-bit.*x86-64" ;;
      linux-arm64) EXPECT="ELF 64-bit.*aarch64" ;;
      win32) EXPECT="PE32\+.*x86-64" ;;
      *) EXPECT="" ;;
    esac
    if [[ -n "${EXPECT}" ]] && ! [[ "${DESC}" =~ ${EXPECT} ]]; then
      echo "✗ ${ASSET_NAME} has the wrong architecture for ${PLATFORM}:" >&2
      echo "    got:      ${DESC}" >&2
      echo "    expected: ${EXPECT}" >&2
      exit 1
    fi
    echo "  ✓ arch ok: ${DESC}"
  fi
done

echo ""
echo "Downloaded simulator-server binaries:"
find "${DEST_DIR}" \( -name simulator-server -o -name 'simulator-server.exe' \) -type f -exec ls -la {} \;

# The simulator-server `android_device` controller pushes the screen-sharing
# agent (host-independent .jar + per-ABI .so) to the phone over adb, resolving
# it from `resources/android/` relative to its working directory — which the
# blueprint sets to the bin root via simulatorServerRunDir(). The payload runs
# on the phone, so one shared copy serves every host platform.
# A missing asset is tolerated: physical-device support is then unavailable.
AGENT_ASSET="screen-sharing-agent.tar.gz"
AGENT_TMP="$(mktemp -d)"
echo ""
echo "Downloading ${AGENT_ASSET} (Android physical-device screen-sharing agent)"
GH_STDERR="$(mktemp)"
if gh release download "${TAG}" \
     --repo "${REPO}" \
     --pattern "${AGENT_ASSET}" \
     --dir "${AGENT_TMP}" \
     --clobber 2>"${GH_STDERR}"; then
  rm -f "${GH_STDERR}"
  res_dir="${DEST_DIR}/resources/android"
  rm -rf "${res_dir}"
  mkdir -p "${res_dir}"
  tar -xzf "${AGENT_TMP}/${AGENT_ASSET}" -C "${res_dir}"
  echo "  ✓ screen-sharing agent → ${res_dir}"
else
  GH_MSG=$(<"${GH_STDERR}")
  rm -f "${GH_STDERR}"
  echo "  ⚠ ${AGENT_ASSET} not downloaded — physical Android device support will be unavailable"
  [[ -n "${GH_MSG}" ]] && printf '    gh: %s\n' "${GH_MSG//$'\n'/$'\n    gh: '}"
fi
rm -rf "${AGENT_TMP}"

# Only the macOS binary carries an Apple signature; codesign would noisily fail
# on the others.
if command -v codesign &>/dev/null && [[ -f "${DEST_DIR}/darwin/simulator-server" ]]; then
  codesign -dvv "${DEST_DIR}/darwin/simulator-server" 2>&1 \
    || echo "Warning: macOS signature verification failed"
fi
