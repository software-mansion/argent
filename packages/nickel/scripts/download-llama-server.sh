#!/usr/bin/env bash
set -euo pipefail

# Vendor a llama-server binary into packages/nickel/bin/<platform>/ so the packaged
# Nickel runtime is self-contained — the analogue of scripts/download-simulator-server.sh.
#
# Unlike simulator-server, llama-server is upstream (ggml-org/llama.cpp), not ours, and
# the MODEL (~5 GB) is fetched+cached by llama-server's own `-hf` at runtime (see
# `nickel init`), so this script only provisions the BINARY.
#
# Resolution order (host binary today; a per-platform CI download is the TODO):
#   1. $NICKEL_LLAMA_SERVER_BIN if set
#   2. a llama-server already on PATH (e.g. `brew install llama.cpp`)
#   3. on macOS with Homebrew: offer to `brew install llama.cpp`
# The resolved binary is copied to bin/<platform>/llama-server. The runtime resolver
# (runtime/llama-server.ts) also falls back to PATH, so vendoring is optional for local
# dev and only strictly needed when shipping the npm tarball to a machine without llama.cpp.
#
# Usage: ./scripts/download-llama-server.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${HERE}/bin"

# Host platform key — mirrors hostPlatformKey() in runtime/llama-server.ts.
case "$(uname -s)" in
  Darwin) PLATFORM="darwin" ;;
  Linux)  [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "arm64" ]] && PLATFORM="linux-arm64" || PLATFORM="linux" ;;
  *)      echo "Unsupported host $(uname -s); set NICKEL_LLAMA_SERVER_BIN manually." >&2; exit 1 ;;
esac
PLATFORM_DIR="${DEST_DIR}/${PLATFORM}"

resolve_bin() {
  if [[ -n "${NICKEL_LLAMA_SERVER_BIN:-}" && -x "${NICKEL_LLAMA_SERVER_BIN}" ]]; then
    echo "${NICKEL_LLAMA_SERVER_BIN}"; return 0
  fi
  if command -v llama-server >/dev/null 2>&1; then
    command -v llama-server; return 0
  fi
  # macOS convenience: install via Homebrew if available.
  if [[ "${PLATFORM}" == "darwin" ]] && command -v brew >/dev/null 2>&1; then
    echo "llama-server not found — installing llama.cpp via Homebrew…" >&2
    brew install llama.cpp >&2
    command -v llama-server; return 0
  fi
  return 1
}

if ! BIN="$(resolve_bin)"; then
  echo "✗ Could not find or install llama-server." >&2
  echo "  Install llama.cpp (https://github.com/ggml-org/llama.cpp) so \`llama-server\` is on PATH," >&2
  echo "  or set NICKEL_LLAMA_SERVER_BIN, then re-run. The runtime also accepts NICKEL_LLAMA_URL." >&2
  exit 1
fi

# Only vendor a SELF-CONTAINED binary. A dynamically-linked build (e.g. Homebrew's
# llama-server, which resolves libllama*/libggml via an `@loader_path/../lib` rpath and
# absolute /opt/homebrew paths) breaks the moment it's copied away from its dylibs — so
# a naive `cp` would ship a binary that dies at spawn with "Library not loaded". Detect
# that on macOS with otool and refuse; the runtime resolver falls back to PATH, which
# works for local dev. Shipping a truly self-contained binary is a CI job (build static,
# or bundle the dylib tree) — the TODO that mirrors simulator-server's signed release.
if [[ "${PLATFORM}" == "darwin" ]] && command -v otool >/dev/null 2>&1; then
  if otool -L "${BIN}" | tail -n +2 | grep -qE '@rpath|/opt/homebrew|/usr/local/(opt|Cellar)'; then
    echo "⚠ ${BIN} is dynamically linked to non-system dylibs (Homebrew build)."
    echo "  Not vendoring — a bare copy would fail to load its libraries at spawn."
    echo "  The Nickel runtime will use this binary from PATH instead (works for local dev)."
    echo "  To ship a self-contained package, build a static/bundled llama-server in CI"
    echo "  and drop it at ${PLATFORM_DIR}/llama-server (or set NICKEL_LLAMA_SERVER_BIN)."
    echo "Next: \`nickel init\` to warm the ${NICKEL_MODEL:-Gemma-4} model cache."
    exit 0
  fi
fi

mkdir -p "${PLATFORM_DIR}"
cp "${BIN}" "${PLATFORM_DIR}/llama-server"
chmod +x "${PLATFORM_DIR}/llama-server"
echo "✓ Vendored self-contained llama-server → ${PLATFORM_DIR}/llama-server"
echo "  (source: ${BIN})"
command -v file >/dev/null 2>&1 && file -b "${PLATFORM_DIR}/llama-server" | sed 's/^/  arch: /'
echo "Next: \`nickel init\` to warm the ${NICKEL_MODEL:-Gemma-4} model cache."
