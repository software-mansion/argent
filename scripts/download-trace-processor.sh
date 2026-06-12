#!/usr/bin/env bash
set -euo pipefail

# Downloads the Perfetto trace-processor WASM engine bundle from
# argent-private-releases and verifies it, so the in-process Android profiler
# engine (packages/native-devtools-android/src/wasm-trace-processor.ts) has its
# three third-party artifacts at build time without committing them to the repo:
#
#   - trace_processor.wasm     Google's prebuilt memory32 wasm (~13 MB)
#   - engine_bundle.node.js    Google's emscripten glue, one Node edit baked in
#   - engine.mjs               @lynx-js/trace-processor's EngineBase decoder
#   - LICENSE                  Perfetto Apache-2.0 license (compliance)
#
# All four are public, not-ours code, produced + checksummed in argent-private
# CI and shipped as a single trace-processor-wasm.tar.gz (+ .sha256) release
# asset. sha256 verification is FATAL here: these blobs are unsigned, so a
# mismatch means a corrupt or tampered download and we refuse to proceed.
#
# Usage: ./scripts/download-trace-processor.sh [release-tag]
#   release-tag  Tag to download from (e.g. argent-v0.5.3). Defaults to argent-main.
#
# Requires:
#   - gh CLI (no authentication needed — the repo is public)

REPO="software-mansion-labs/argent-private-releases"
TAG="${1:-argent-main}"
DEST="packages/native-devtools-android/assets/trace-processor"
TARBALL="trace-processor-wasm.tar.gz"
CHECKSUM="${TARBALL}.sha256"
FILES=(trace_processor.wasm engine_bundle.node.js engine.mjs LICENSE)

# sha256 helper: prefer sha256sum (Linux), fall back to shasum -a 256 (macOS).
if command -v sha256sum &>/dev/null; then
  sha256() { sha256sum "$@"; }
elif command -v shasum &>/dev/null; then
  sha256() { shasum -a 256 "$@"; }
else
  echo "Error: neither sha256sum nor shasum found." >&2
  exit 1
fi

# Verify the release exists before attempting downloads.
if ! gh release view "${TAG}" --repo "${REPO}" &>/dev/null; then
  echo "Error: release '${TAG}' not found in ${REPO}." >&2
  echo "Build and publish the trace-processor WASM bundle for this version first, then retry." >&2
  exit 1
fi

echo "Downloading ${TARBALL} from ${REPO} (tag: ${TAG})..."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

gh release download "${TAG}" \
  --repo "${REPO}" \
  --pattern "${TARBALL}" \
  --pattern "${CHECKSUM}" \
  --dir "${TMP_DIR}" \
  --clobber

# Fatal: verify the tarball against its published checksum before unpacking.
EXPECTED="$(awk '{print $1}' "${TMP_DIR}/${CHECKSUM}")"
ACTUAL="$(sha256 "${TMP_DIR}/${TARBALL}" | awk '{print $1}')"
if [[ -z "${EXPECTED}" || "${EXPECTED}" != "${ACTUAL}" ]]; then
  echo "Error: sha256 mismatch for ${TARBALL}." >&2
  echo "  expected: ${EXPECTED:-<empty>}" >&2
  echo "  actual:   ${ACTUAL}" >&2
  exit 1
fi
echo "sha256 OK (${TARBALL})"

# Unpack into the destination (creating it if missing).
mkdir -p "${DEST}"
tar -xzf "${TMP_DIR}/${TARBALL}" -C "${DEST}"

# Defense in depth: re-verify every extracted file against the in-tarball
# SHA256SUMS manifest. Any mismatch is fatal.
( cd "${DEST}" && sha256 -c SHA256SUMS )

# Assert each expected artifact actually landed.
for f in "${FILES[@]}"; do
  if [[ ! -f "${DEST}/${f}" ]]; then
    echo "Error: expected artifact missing after extract: ${DEST}/${f}" >&2
    exit 1
  fi
done

echo "Downloaded + verified trace-processor WASM bundle to ${DEST}/"
