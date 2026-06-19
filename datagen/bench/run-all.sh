#!/usr/bin/env bash
# Run the LOCAL benchmark cells (the 2 Claude Haiku cells are deferred until an
# ANTHROPIC_API_KEY is supplied). SERIALIZED on purpose: one model + one toolkit at
# a time — this is a 26 GB M4 Pro with an iOS simulator + Ollama already resident, so
# concurrency risks swap-thrash (it has paniced under load before).
#
# Prereqs:
#   - Ollama running with `silver:e4b` and `gemma4:e4b` pulled.
#   - Exactly one iOS simulator booted (iPhone 16 Pro Max), Settings reachable.
#   - ~/.hermes/config.yaml has providers (ollama-launch) + mcp_servers (argent, agent-device).
#     See README.md "Hermes config".
set -euo pipefail
cd "$(dirname "$0")"

for toolkit in argent agent-device; do
  for model in silver:e4b gemma4:e4b; do
    name="${toolkit//-/}_${model//:/}"
    echo "=== CELL $name ==="
    ./run-cell.sh "$model" "$toolkit" "out/$name"
  done
done

# Haiku cells (run on Monday once the key is set):
#   ./run-cell.sh claude-haiku argent       out/argent_claudehaiku      --provider anthropic
#   ./run-cell.sh claude-haiku agent-device out/agentdevice_claudehaiku --provider anthropic

echo "=== scoring ==="
python3 judge.py out/*/
python3 judge.py --table out/*/
