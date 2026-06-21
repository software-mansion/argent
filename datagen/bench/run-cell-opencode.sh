#!/usr/bin/env bash
# Run ONE benchmark cell — (model × toolkit) — over tasks.jsonl using OpenCode as the
# agent harness. OpenCode drives the model through the toolkit's MCP tools against a
# REAL booted iOS simulator; we capture each task's JSON event stream (tool calls +
# results + final text) for scoring.
#
#   ./run-cell-opencode.sh <model> <agent> <out-dir>
#     ./run-cell-opencode.sh ollama/gemma4:e4b argentbench out/argent_gemma4
#     ./run-cell-opencode.sh ollama/silver:e4b argentbench out/argent_silver
#
# Prereqs (see README): ollama up with OLLAMA_CONTEXT_LENGTH=32768; the iPhone 16 Pro
# Max booted; the `<agent>` defined in ~/.config/opencode/agent/ restricting tools to
# the toolkit (argentbench = argent-only). One model at a time (memory).
set -euo pipefail
cd "$(dirname "$0")"

MODEL="${1:?model e.g. ollama/gemma4:e4b}"; AGENT="${2:?agent e.g. argentbench}"; OUT="${3:?out-dir}"
UDID="${UDID:-6DBF83B4-F341-4F8D-B48D-CD8FF312CCFB}"
TIMEOUT="${TIMEOUT:-600}"
mkdir -p "$OUT"

reset_sim() {  # clean start: terminate the apps our tasks touch (each task re-opens Settings)
  for b in com.apple.Preferences com.apple.mobilesafari; do
    xcrun simctl terminate "$UDID" "$b" >/dev/null 2>&1 || true
  done
  sleep 1
}

n=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(jq -r .id <<<"$line"); prompt=$(jq -r .prompt <<<"$line")
  echo ">> [$AGENT/$MODEL] $id"
  reset_sim
  timeout "$TIMEOUT" opencode run "$prompt" --agent "$AGENT" -m "$MODEL" \
    --dangerously-skip-permissions --format json </dev/null >"$OUT/$id.json" 2>"$OUT/$id.err" || true
  # final sim screen as evidence for the judge / deterministic checks
  xcrun simctl io "$UDID" screenshot "$OUT/$id.after.png" >/dev/null 2>&1 || true
  n=$((n + 1))
done <tasks.jsonl
echo "cell done: $n tasks -> $OUT"
