#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# test-install-matrix.sh
#
# Tests global installation of @software-mansion/argent across package managers.
# Run from the repo root after building the package (npm run pack:mcp).
#
# Usage:
#   ./scripts/test-install-matrix.sh [tarball-path]
#
# If no tarball is provided, it runs `npm run pack:mcp` to generate one.
#
# Prerequisites:
#   - npm, pnpm, and yarn (v1 classic) must be installed globally
#   - macOS or Linux (Windows not supported by this script)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
RED="\033[31m"
CYAN="\033[36m"
DIM="\033[2m"
RESET="\033[0m"

pass() { echo -e "  ${GREEN}✓${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; FAILURES=$((FAILURES + 1)); }
section() { echo -e "\n${BOLD}${CYAN}── $1 ──${RESET}"; }

FAILURES=0
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Build tarball if not provided ──────────────────────────────────────────────

TARBALL="${1:-}"
if [ -z "$TARBALL" ]; then
  section "Packing tarball"
  cd "$REPO_ROOT"
  npm run pack:mcp 2>&1
  TARBALL=$(ls -t "$REPO_ROOT"/software-mansion-argent-*.tgz 2>/dev/null | head -1)
  if [ -z "$TARBALL" ]; then
    echo -e "${RED}ERROR: No tarball found after pack:mcp${RESET}"
    exit 1
  fi
  echo -e "  Tarball: ${DIM}${TARBALL}${RESET}"
fi

if [ ! -f "$TARBALL" ]; then
  echo -e "${RED}ERROR: Tarball not found: ${TARBALL}${RESET}"
  exit 1
fi

TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"

# ── Test function ──────────────────────────────────────────────────────────────

test_package_manager() {
  local PM="$1"
  local INSTALL_CMD="$2"
  local UNINSTALL_CMD="$3"

  section "Testing with ${PM}"

  # Check if package manager is available
  if ! command -v "$PM" &>/dev/null; then
    echo -e "  ${RED}SKIP: ${PM} not installed${RESET}"
    return
  fi

  echo -e "  ${DIM}$(${PM} --version)${RESET}"

  # Install globally from tarball
  echo "  Installing globally..."
  if eval "$INSTALL_CMD" 2>&1 | tail -3; then
    pass "Global install succeeded"
  else
    fail "Global install failed"
    return
  fi

  # Verify argent binary is on PATH
  if command -v argent &>/dev/null; then
    pass "argent binary found on PATH"
  else
    fail "argent binary NOT on PATH"
    eval "$UNINSTALL_CMD" 2>/dev/null || true
    return
  fi

  # Verify argent --version works
  local VERSION
  VERSION=$(argent --version 2>&1 || true)
  if [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
    pass "argent --version = ${VERSION}"
  else
    fail "argent --version returned unexpected output: ${VERSION}"
  fi

  # Verify argent-mcp binary is on PATH
  if command -v argent-mcp &>/dev/null; then
    pass "argent-mcp binary found on PATH"
  else
    fail "argent-mcp binary NOT on PATH"
  fi

  # Create temp project and run argent init --yes
  local TEMP_PROJECT
  TEMP_PROJECT=$(mktemp -d)
  echo "  Testing init in ${DIM}${TEMP_PROJECT}${RESET}"

  pushd "$TEMP_PROJECT" >/dev/null

  # Create minimal editor directories so adapters detect them
  mkdir -p .cursor .claude .vscode

  if argent init --yes 2>&1 | tail -5; then
    pass "argent init --yes succeeded"
  else
    fail "argent init --yes failed"
  fi

  # Verify MCP configs were written
  if [ -f ".cursor/mcp.json" ]; then
    if grep -q '"argent"' .cursor/mcp.json 2>/dev/null; then
      pass "Cursor MCP config contains argent entry"
    else
      fail "Cursor MCP config missing argent entry"
    fi
  fi

  if [ -f ".mcp.json" ]; then
    if grep -q '"argent"' .mcp.json 2>/dev/null; then
      pass "Claude Code MCP config contains argent entry"
    else
      fail "Claude Code MCP config missing argent entry"
    fi
  fi

  if [ -f ".vscode/mcp.json" ]; then
    if grep -q '"argent"' .vscode/mcp.json 2>/dev/null; then
      pass "VS Code MCP config contains argent entry"
    else
      fail "VS Code MCP config missing argent entry"
    fi
  fi

  # Run argent uninstall --yes --prune (but don't actually uninstall the package)
  if argent uninstall --yes --prune 2>&1 | tail -5; then
    pass "argent uninstall --yes --prune succeeded"
  else
    fail "argent uninstall --yes --prune failed"
  fi

  # Verify MCP entries were removed
  if [ -f ".cursor/mcp.json" ]; then
    if ! grep -q '"argent"' .cursor/mcp.json 2>/dev/null; then
      pass "Cursor MCP entry removed after uninstall"
    else
      fail "Cursor MCP entry still present after uninstall"
    fi
  fi

  popd >/dev/null
  rm -rf "$TEMP_PROJECT"

  # Global uninstall
  echo "  Uninstalling globally..."
  if eval "$UNINSTALL_CMD" 2>&1 | tail -3; then
    pass "Global uninstall succeeded"
  else
    fail "Global uninstall failed"
  fi

  # Verify binary is gone
  if ! command -v argent &>/dev/null; then
    pass "argent binary removed from PATH"
  else
    fail "argent binary still on PATH after uninstall"
  fi
}

# ── Run matrix ─────────────────────────────────────────────────────────────────

section "Install Matrix Test"
echo -e "  Tarball: ${DIM}${TARBALL}${RESET}"

test_package_manager \
  "npm" \
  "npm install -g \"${TARBALL}\"" \
  "npm uninstall -g @software-mansion/argent"

test_package_manager \
  "pnpm" \
  "pnpm add -g \"${TARBALL}\"" \
  "pnpm remove -g @software-mansion/argent"

test_package_manager \
  "yarn" \
  "yarn global add \"file:${TARBALL}\"" \
  "yarn global remove @software-mansion/argent"

# ── Summary ────────────────────────────────────────────────────────────────────

section "Summary"
if [ "$FAILURES" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}All tests passed.${RESET}"
  exit 0
else
  echo -e "  ${RED}${BOLD}${FAILURES} failure(s).${RESET}"
  exit 1
fi
