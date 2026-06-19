#!/usr/bin/env bash
# Serve silver:e4b locally with MLX — the practical dev/test server on Apple
# Silicon (vLLM has no Mac build; MLX is Apple's own, fast on M-series).
# OpenAI-compatible API at http://127.0.0.1:8080/v1.
#
#   ./serve-mlx.sh                 # 4-bit base + adapter (~4 GB, low memory)
#   FUSED=1 ./serve-mlx.sh         # merged bf16 (~14 GB — needs the headroom)
set -euo pipefail
cd "$(dirname "$0")/.."
PY="../../.venv/bin/python"
PORT="${PORT:-8080}"

if [ "${FUSED:-0}" = "1" ]; then
  exec "$PY" -m mlx_lm.server --model fused/silver-e4b-causal --port "$PORT"
else
  # 4-bit base + LoRA adapter applied at load: same weights, ~4 GB instead of ~14 GB.
  exec "$PY" -m mlx_lm.server \
    --model base/gemma-4-e4b-clean \
    --adapter-path adapters/gemma4-e4b-argent \
    --port "$PORT"
fi
