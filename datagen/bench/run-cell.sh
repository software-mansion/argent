#!/usr/bin/env bash
# Run ONE benchmark cell — a (model × toolkit) pair — over tasks.jsonl using Hermes
# as the agent harness (established runtime; we don't reimplement the agent loop).
#
#   ./run-cell.sh <model> <toolkit> <out-dir> [extra hermes flags...]
#     ./run-cell.sh silver:e4b   argent       out/argent_silver
#     ./run-cell.sh gemma4:e4b   agent-device out/agentdevice_gemma4
#     ./run-cell.sh claude-haiku argent       out/argent_haiku   --provider anthropic
#
# Each task: one headless `hermes chat` run isolated to a single MCP toolset (-t),
# capturing the final answer + the full transcript (tool calls) via session export.
# Model selection is config-driven for local Ollama (provider `ollama-launch` in
# ~/.hermes/config.yaml); Claude Haiku passes `--provider anthropic` as an extra flag.
set -euo pipefail
cd "$(dirname "$0")"

MODEL="${1:?model}"; TOOLKIT="${2:?toolkit}"; OUT="${3:?out-dir}"; shift 3
EXTRA=("$@")
MAX_TURNS="${MAX_TURNS:-18}"
mkdir -p "$OUT"
export HERMES_YOLO_MODE=1 HERMES_ACCEPT_HOOKS=1 HERMES_INTERACTIVE=0

n=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(jq -r .id <<<"$line")
  prompt=$(jq -r .prompt <<<"$line")
  echo ">> [$TOOLKIT/$MODEL] $id"
  # One isolated agent run. `|| true` so one bad task doesn't abort the cell.
  out=$(timeout 360 hermes chat -q "$prompt" -m "$MODEL" -t "$TOOLKIT" \
        -Q --yolo --accept-hooks --max-turns "$MAX_TURNS" "${EXTRA[@]}" \
        2>"$OUT/$id.err" || true)
  printf '%s\n' "$out" >"$OUT/$id.answer.txt"
  sid=$(grep -oE "session_id:[[:space:]]*[A-Za-z0-9_]+" <<<"$out" | awk '{print $NF}' | tail -1)
  if [ -n "${sid:-}" ]; then
    hermes sessions export - --session-id "$sid" >"$OUT/$id.transcript.jsonl" 2>/dev/null || true
  fi
  n=$((n + 1))
done <tasks.jsonl
echo "cell done: $n tasks -> $OUT"
