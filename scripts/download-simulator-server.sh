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
#   - gh CLI, authenticated (`gh auth login` or `GH_TOKEN` env var). The release
#     repo is public but `gh release download` still requires authentication.

REPO="software-mansion-labs/simulator-server-releases"
TAG="${1:-radon-main}"
DEST_DIR="packages/native-devtools-ios/bin"

# release-asset-name → host platform key. Asset names follow the upstream
# build matrix (`simulator-server-argent-{macos,linux,linux-arm64,windows.exe}`);
# the keys mirror hostPlatformKey() in @argent/native-devtools-ios
# (process.platform, except "linux-arm64" on arm64 Linux) so the resolver can
# look up by host. The Windows asset keeps its `.exe` extension end-to-end —
# the release asset, the local copy, and what the resolver/dispatcher spawn.
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
  # Windows ships a PE `.exe`; every other host an extensionless binary. The
  # resolver (simulatorServerBinaryName()) and the dispatcher pick the same
  # name by host, so the on-disk copy must match.
  if [[ "${PLATFORM}" == "win32" ]]; then
    BIN_BASENAME="simulator-server.exe"
  else
    BIN_BASENAME="simulator-server"
  fi

  # Purge then recreate the platform dir before each download so a previous
  # run's stale binary can't ship if THIS run's download fails. Without this,
  # the failure branch below would print a warning and continue, leaving the
  # stale binary in place — and the publish workflow would silently package
  # an outdated artifact.
  rm -rf "${PLATFORM_DIR}"
  mkdir -p "${PLATFORM_DIR}"

  echo "Downloading ${ASSET_NAME} → ${PLATFORM_DIR}/${BIN_BASENAME}"
  # Tolerate missing assets so the script keeps working for macOS-only
  # consumers when the Linux artifact lags behind a release. Capture gh's
  # stderr and print it on failure so "not authenticated" vs "asset missing"
  # vs "rate-limited" stays distinguishable (the prior `2>/dev/null` masked
  # all three).
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
    # PLATFORM_DIR is empty because we purged it above, so this rmdir
    # succeeds and the dir disappears — keeping the inventory clean.
    rmdir "${PLATFORM_DIR}" 2>/dev/null || true
    continue
  fi
  rm -f "${GH_STDERR}"

  mv "${PLATFORM_DIR}/${ASSET_NAME}" "${PLATFORM_DIR}/${BIN_BASENAME}"
  chmod +x "${PLATFORM_DIR}/${BIN_BASENAME}"

  # Architecture sanity check: a wrong-arch binary in a platform dir is worse
  # than a missing one — the resolver would happily pick it and the user gets
  # an ENOEXEC at spawn time with no hint of the root cause. Fail hard here
  # (unlike the missing-asset case above) because a present-but-mislabeled
  # asset is an upstream packaging bug that must not ship.
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

# Physical-Android-device support: the simulator-server `android_device`
# controller pushes the screen-sharing agent (a host-independent .jar + a
# per-ABI .so) to the phone over adb, resolving them at runtime from
# `resources/android/` relative to its working directory — which the blueprint
# sets to the binary's own platform dir. The agent payload runs on the phone,
# not the host, so a single release tarball serves every host platform; extract
# a copy next to each downloaded binary. Tolerate a missing asset the same way
# as a missing binary so macOS/Linux-only consumers and older releases (before
# the agent was published) still work — physical-device support just won't be
# available until the asset is present.
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
  # Extract once into every platform dir that actually has a binary, so the
  # agent sits at <platform>/resources/android/ next to simulator-server.
  while IFS= read -r bin; do
    plat_dir="$(dirname "${bin}")"
    res_dir="${plat_dir}/resources/android"
    rm -rf "${res_dir}"
    mkdir -p "${res_dir}"
    tar -xzf "${AGENT_TMP}/${AGENT_ASSET}" -C "${res_dir}"
    echo "  ✓ screen-sharing agent → ${res_dir}"
  done < <(find "${DEST_DIR}" \( -name simulator-server -o -name 'simulator-server.exe' \) -type f)
else
  GH_MSG=$(<"${GH_STDERR}")
  rm -f "${GH_STDERR}"
  echo "  ⚠ ${AGENT_ASSET} not downloaded — physical Android device support will be unavailable"
  [[ -n "${GH_MSG}" ]] && printf '    gh: %s\n' "${GH_MSG//$'\n'/$'\n    gh: '}"
fi
rm -rf "${AGENT_TMP}"

# Only the macOS binary is signed and codesignable; the Linux ELF doesn't
# carry an Apple signature, and `codesign` would noisily fail on it.
if command -v codesign &>/dev/null && [[ -f "${DEST_DIR}/darwin/simulator-server" ]]; then
  codesign -dvv "${DEST_DIR}/darwin/simulator-server" 2>&1 \
    || echo "Warning: macOS signature verification failed"
fi
