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

# Train on the full sequence (no --mask-prompt): these are multi-turn
# trajectories and we want loss on EVERY assistant tool-call turn, not just the
# final answer (mlx-lm's mask-prompt masks all but the last assistant turn).
exec "$PY" -m mlx_lm.lora \
  --model "$MODEL" \
  --train \
  --data data \
  --adapter-path "$ADAPTER" \
  --fine-tune-type lora \
  --num-layers 8 \
  --batch-size 1 \
  --iters "$ITERS" \
  --max-seq-length 2600 \
  --learning-rate 5e-5 \
  --steps-per-report 20 \
  --steps-per-eval 300 \
  --val-batches 8 \
  --save-every 300 \
  --grad-checkpoint
