#!/usr/bin/env bash
# Serve silver:e4b with vLLM — the Gemma team's recommended dev/test server.
#
# REQUIRES a CUDA GPU on Linux. vLLM has no Apple-Silicon wheel and no Metal
# backend, so this does NOT run on the Mac this model was trained on — use
# serve-mlx.sh there. Run this on your GPU box (the model is on the Hub).
#
# gemma4 support landed in recent vLLM (Gemma4ForCausalLM is in the model
# registry as of v0.23 / current main). Older vLLM will reject the architecture.
#
#   ./serve-vllm.sh                      # serves LatekVo/silver
#   MODEL=/path/to/silver-e4b-causal ./serve-vllm.sh   # local merged weights
set -euo pipefail

MODEL="${MODEL:-LatekVo/silver}"
PORT="${PORT:-8000}"

# The model emits <tool_call>{...}</tool_call> as TEXT (not vLLM's structured
# tool-call format), so we do NOT enable --tool-call-parser; the agent loop parses
# the tags itself (see serving/README.md). Pass the Argent system prompt per request.
#
# --max-model-len 32768: the Argent system prompt + tool schemas + a multi-turn
# transcript easily overflow a small window (the same truncation that bit the
# Ollama build at its 4096 default). gemma4 E4B supports up to 131072 if you have
# the KV-cache headroom on the GPU.
exec vllm serve "$MODEL" \
  --served-model-name silver-e4b \
  --max-model-len 32768 \
  --dtype bfloat16 \
  --port "$PORT"
