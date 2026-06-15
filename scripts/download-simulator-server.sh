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
# build matrix (`simulator-server-argent-{macos,linux,linux-arm64}`); the keys
# mirror hostPlatformKey() in @argent/native-devtools-ios (process.platform,
# except "linux-arm64" on arm64 Linux) so the resolver can lookup by host.
declare -a TARGETS=(
  "simulator-server-argent-macos:darwin"
  "simulator-server-argent-linux:linux"
  "simulator-server-argent-linux-arm64:linux-arm64"
)

mkdir -p "${DEST_DIR}"

for entry in "${TARGETS[@]}"; do
  ASSET_NAME="${entry%%:*}"
  PLATFORM="${entry##*:}"
  PLATFORM_DIR="${DEST_DIR}/${PLATFORM}"

  # Purge then recreate the platform dir before each download so a previous
  # run's stale binary can't ship if THIS run's download fails. Without this,
  # the failure branch below would print a warning and continue, leaving the
  # stale binary in place — and the publish workflow would silently package
  # an outdated artifact.
  rm -rf "${PLATFORM_DIR}"
  mkdir -p "${PLATFORM_DIR}"

  echo "Downloading ${ASSET_NAME} → ${PLATFORM_DIR}/simulator-server"
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

  mv "${PLATFORM_DIR}/${ASSET_NAME}" "${PLATFORM_DIR}/simulator-server"
  chmod +x "${PLATFORM_DIR}/simulator-server"

  # Architecture sanity check: a wrong-arch binary in a platform dir is worse
  # than a missing one — the resolver would happily pick it and the user gets
  # an ENOEXEC at spawn time with no hint of the root cause. Fail hard here
  # (unlike the missing-asset case above) because a present-but-mislabeled
  # asset is an upstream packaging bug that must not ship.
  if command -v file >/dev/null 2>&1; then
    DESC="$(file -b "${PLATFORM_DIR}/simulator-server")"
    case "${PLATFORM}" in
      darwin) EXPECT="Mach-O universal" ;;
      linux) EXPECT="ELF 64-bit.*x86-64" ;;
      linux-arm64) EXPECT="ELF 64-bit.*aarch64" ;;
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
find "${DEST_DIR}" -name simulator-server -type f -exec ls -la {} \;

# Only the macOS binary is signed and codesignable; the Linux ELF doesn't
# carry an Apple signature, and `codesign` would noisily fail on it.
if command -v codesign &>/dev/null && [[ -f "${DEST_DIR}/darwin/simulator-server" ]]; then
  codesign -dvv "${DEST_DIR}/darwin/simulator-server" 2>&1 \
    || echo "Warning: macOS signature verification failed"
fi
