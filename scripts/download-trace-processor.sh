#!/usr/bin/env bash
set -euo pipefail

# Downloads the Perfetto trace-processor WASM engine bundle from
# argent-private-releases and verifies it, so the in-process Android profiler
# engine (packages/native-devtools-android/src/wasm-trace-processor.ts) has its
# third-party artifacts at build time without committing them to the repo:
#
#   - trace_processor.wasm     Google's prebuilt memory32 wasm
#   - engine_bundle.node.js    Google's emscripten glue, one Node edit baked in
#   - LICENSE                  Perfetto license (compliance)
#
# Only these files are copied into place. The tarball may hold more (older
# releases also carry an engine.mjs RPC decoder that argent no longer uses).
#
# Built and checksummed in argent-private CI, shipped as a single
# trace-processor-wasm.tar.gz (+ .sha256) release asset. The blobs are unsigned,
# so a sha256 mismatch is fatal: it means a corrupt or incomplete download. The
# checksum comes from the same release as the tarball, so it proves integrity
# only: whoever can replace the tarball there can replace the checksum too.
#
# Usage: ./scripts/download-trace-processor.sh [release-tag]
#   release-tag  Tag to download from (e.g. argent-v0.5.3). Defaults to argent-main.
#
# Requires:
#   - gh CLI, logged in with `gh auth login` (the repo is public, but the
#     `gh release view` pre-check still needs auth)

REPO="software-mansion-labs/argent-private-releases"
TAG="${1:-argent-main}"
DEST="packages/native-devtools-android/assets/trace-processor"
TARBALL="trace-processor-wasm.tar.gz"
CHECKSUM="${TARBALL}.sha256"
FILES=(trace_processor.wasm engine_bundle.node.js LICENSE)

if command -v sha256sum &>/dev/null; then
  sha256() { sha256sum "$@"; }
elif command -v shasum &>/dev/null; then
  sha256() { shasum -a 256 "$@"; }
else
  echo "Error: neither sha256sum nor shasum found." >&2
  exit 1
fi

if ! gh release view "${TAG}" --repo "${REPO}" &>/dev/null; then
  echo "Error: release '${TAG}' not found in ${REPO}, or gh is not logged in (gh auth login)." >&2
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

EXPECTED="$(awk '{print $1}' "${TMP_DIR}/${CHECKSUM}")"
ACTUAL="$(sha256 "${TMP_DIR}/${TARBALL}" | awk '{print $1}')"
if [[ -z "${EXPECTED}" || "${EXPECTED}" != "${ACTUAL}" ]]; then
  echo "Error: sha256 mismatch for ${TARBALL}." >&2
  echo "  expected: ${EXPECTED:-<empty>}" >&2
  echo "  actual:   ${ACTUAL}" >&2
  exit 1
fi
echo "sha256 OK (${TARBALL})"

EXTRACT_DIR="${TMP_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"
tar -xzf "${TMP_DIR}/${TARBALL}" -C "${EXTRACT_DIR}"

# Defense in depth: the tarball checksum already passed.
( cd "${EXTRACT_DIR}" && sha256 -c SHA256SUMS )

mkdir -p "${DEST}"
# Drop files that an older download left behind.
rm -f "${DEST}/engine.mjs" "${DEST}/SHA256SUMS"
for f in "${FILES[@]}"; do
  if [[ ! -f "${EXTRACT_DIR}/${f}" ]]; then
    echo "Error: expected artifact missing after extract: ${f}" >&2
    exit 1
  fi
  cp "${EXTRACT_DIR}/${f}" "${DEST}/${f}"
done

echo "Downloaded + verified trace-processor WASM bundle to ${DEST}/"
