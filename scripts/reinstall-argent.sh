#!/bin/bash

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GLOBAL_ROOT="$(npm root -g)"

echo "1. Killing existing Argent processes"

pkill -f "$GLOBAL_ROOT/argent/dist" || true
pkill -f "$REPO_ROOT/packages/mcp/dist" || true

echo "2. Building and installing"

cd "$REPO_ROOT"
npm run pack:mcp

TGZ_FILENAME=$(ls "$REPO_ROOT"/argent-*.tgz | sort -V | tail -n 1)
npm install -g "$TGZ_FILENAME"

echo "=== Done. MCP client will restart the daemon on next tool call. ==="
