#!/usr/bin/env bash
# Train the CORRECTED silver: native gemma4 tool format + no narration + a FIXED
# 10-tool nav set (train == inference, so no tool-name hallucination) + REALISTIC
# observations (the model must `describe` for screen state, matching real argent
# which returns an unreadable screenshot, not a free text view).
#
# Prereq: `node prepare-native.ts --n 2500 --valid 150 --realistic --no-narration
#          --out data-realistic` has run (data-realistic/{train,valid}.jsonl).
# MEMORY: seq 5120 Metal-OOM'd on the BACKWARD pass at 76% system-free (~20 GB) — the
# val forward pass completed, then the first training step's backward+optimizer spiked
# past the available GPU memory. seq 4608 peaks ~17 GB (comfortable even on a fully-idle
# 26 GB machine). Run on a quiet machine (no other GPU users); one model at a time, free
# ollama/llama-server first. ~70 min for 500 iters. Bump SEQ=5120 only with the whole
# machine idle (covers ~79% of examples untruncated vs ~70% at 4608).
set -euo pipefail
cd "$(dirname "$0")"
PY="../../.venv/bin/python"
ITERS="${ITERS:-500}"
SEQ="${SEQ:-4608}"

exec "$PY" -m mlx_lm.lora \
  --model base/gemma-4-e4b-clean \
  --train --data data-realistic \
  --adapter-path adapters/silver-realistic \
  --fine-tune-type lora --num-layers 8 --batch-size 1 \
  --iters "$ITERS" --max-seq-length "$SEQ" --learning-rate 5e-5 \
  --steps-per-report 20 --steps-per-eval 250 --val-batches 8 \
  --save-every 250 --grad-checkpoint
