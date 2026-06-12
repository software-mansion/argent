#!/usr/bin/env bash
set -euo pipefail

# Downloads the per-platform `vega-fast-cli` host binary from the vega-fast-cli
# release repo into packages/native-devtools-vega/bin/<platform>/, the same
# per-platform layout simulator-server uses. Each binary embeds the on-device
# server, so this is the only Vega artifact argent bundles. The bundle step
# (packages/argent/scripts/bundle-tools.cjs) and the runtime resolver
# (packages/tool-server/src/utils/vega-fast-cli.ts) expect this layout.
#
# Each binary is verified against its published .sha256 — FATAL on mismatch.
#
# Usage: ./scripts/download-vega-fast-cli.sh [release-tag]
#   release-tag  Tag to download from (e.g. vega-fast-cli-v0.1.0). Defaults to vega-fast-cli-main.
#
# Requires:
#   - gh CLI, authenticated (`gh auth login` or `GH_TOKEN`). The repo is PRIVATE,
#     so the token needs read access to software-mansion-labs/vega-fast-cli.
#
# Missing/unreadable release is FATAL only when ARGENT_REQUIRE_VEGA_AGENT=1
# (CI/publish); otherwise it warns and exits 0 so local packs stay green.

REPO="software-mansion-labs/vega-fast-cli"
TAG="${1:-vega-fast-cli-main}"
DEST_DIR="packages/native-devtools-vega/bin"

# release-asset-name → process.platform key (mirrors download-simulator-server.sh).
declare -a TARGETS=(
  "vega-fast-cli-macos:darwin"
  "vega-fast-cli-linux:linux"
)

# sha256 helper: prefer sha256sum (Linux), fall back to shasum -a 256 (macOS).
if command -v sha256sum &>/dev/null; then
  sha256() { sha256sum "$@"; }
elif command -v shasum &>/dev/null; then
  sha256() { shasum -a 256 "$@"; }
else
  echo "Error: neither sha256sum nor shasum found." >&2
  exit 1
fi

# Verify the release is visible (the repo is private) before downloading.
if ! gh release view "${TAG}" --repo "${REPO}" &>/dev/null; then
  MSG="release '${TAG}' not found in ${REPO} (or no read access — the repo is private; set a GH_TOKEN with read access)."
  if [[ "${ARGENT_REQUIRE_VEGA_AGENT:-0}" == "1" ]]; then
    echo "Error: ${MSG}" >&2
    exit 1
  fi
  echo "⚠ ${MSG}" >&2
  echo "  Skipping vega-fast-cli download (ARGENT_REQUIRE_VEGA_AGENT != 1)." >&2
  exit 0
fi

mkdir -p "${DEST_DIR}"

for entry in "${TARGETS[@]}"; do
  ASSET_NAME="${entry%%:*}"
  PLATFORM="${entry##*:}"
  PLATFORM_DIR="${DEST_DIR}/${PLATFORM}"

  # Purge then recreate the platform dir so a previous run's stale binary can't
  # ship if THIS download fails.
  rm -rf "${PLATFORM_DIR}"
  mkdir -p "${PLATFORM_DIR}"

  TMP_DIR="$(mktemp -d)"
  echo "Downloading ${ASSET_NAME} → ${PLATFORM_DIR}/vega-fast-cli"
  GH_STDERR="$(mktemp)"
  if ! gh release download "${TAG}" \
       --repo "${REPO}" \
       --pattern "${ASSET_NAME}" \
       --pattern "${ASSET_NAME}.sha256" \
       --dir "${TMP_DIR}" \
       --clobber 2>"${GH_STDERR}"; then
    GH_MSG=$(<"${GH_STDERR}")
    rm -f "${GH_STDERR}"
    echo "  ⚠ ${ASSET_NAME} not downloaded — skipping (Vega won't run on ${PLATFORM} hosts)"
    [[ -n "${GH_MSG}" ]] && printf '    gh: %s\n' "${GH_MSG//$'\n'/$'\n    gh: '}"
    rmdir "${PLATFORM_DIR}" 2>/dev/null || true
    rm -rf "${TMP_DIR}"
    continue
  fi
  rm -f "${GH_STDERR}"

  # Fatal: verify the binary against its published checksum.
  EXPECTED="$(awk '{print $1}' "${TMP_DIR}/${ASSET_NAME}.sha256")"
  ACTUAL="$(sha256 "${TMP_DIR}/${ASSET_NAME}" | awk '{print $1}')"
  if [[ -z "${EXPECTED}" || "${EXPECTED}" != "${ACTUAL}" ]]; then
    echo "Error: sha256 mismatch for ${ASSET_NAME}." >&2
    echo "  expected: ${EXPECTED:-<empty>}" >&2
    echo "  actual:   ${ACTUAL}" >&2
    rm -rf "${TMP_DIR}"
    exit 1
  fi

  install -m 0755 "${TMP_DIR}/${ASSET_NAME}" "${PLATFORM_DIR}/vega-fast-cli"
  rm -rf "${TMP_DIR}"
  echo "  ✓ sha256 OK → ${PLATFORM_DIR}/vega-fast-cli"
done

echo ""
echo "Installed vega-fast-cli host binaries:"
find "${DEST_DIR}" -name vega-fast-cli -type f -exec ls -la {} \;
