#!/usr/bin/env bash
# LoRA fine-tune Gemma 2 2B (4-bit) on the gym dataset with mlx-lm.
# Prereqs: ../../.venv with mlx-lm; `node prepare.ts` has written data/{train,valid,test}.jsonl.
#
#   ./train.sh                 # defaults below
#   ITERS=900 ./train.sh       # override iterations
set -euo pipefail
cd "$(dirname "$0")"

PY="../../.venv/bin/python"
MODEL="${MODEL:-mlx-community/gemma-2-2b-it-4bit}"
ITERS="${ITERS:-700}"
ADAPTER="${ADAPTER:-adapters/gemma-argent}"
mkdir -p "$(dirname "$ADAPTER")"

# --mask-prompt: compute loss only on the model (assistant) turns, so the model
# learns to *emit* tool calls / answers, not to reproduce the user/tool text.
exec "$PY" -m mlx_lm.lora \
  --model "$MODEL" \
  --train \
  --data data \
  --adapter-path "$ADAPTER" \
  --fine-tune-type lora \
  --mask-prompt \
  --num-layers 12 \
  --batch-size 2 \
  --iters "$ITERS" \
  --max-seq-length 3400 \
  --learning-rate 1e-4 \
  --steps-per-report 20 \
  --steps-per-eval 200 \
  --val-batches 20 \
  --save-every 350 \
  --grad-checkpoint
