#!/usr/bin/env bash
# Train the CORRECTED silver: native gemma4 tool format + no narration + a FIXED
# 10-tool nav set (train == inference, so no tool-name hallucination) + REALISTIC
# observations (the model must `describe` for screen state, matching real argent
# which returns an unreadable screenshot, not a free text view).
#
# Prereq: `node prepare-native.ts --n 2500 --valid 150 --realistic --no-narration
#          --out data-realistic` has run (data-realistic/{train,valid}.jsonl).
# Needs ~18 GB free (seq 5120). One model at a time; free other ollama/llama-server
# processes first. ~75 min for 500 iters.
set -euo pipefail
cd "$(dirname "$0")"
PY="../../.venv/bin/python"
ITERS="${ITERS:-500}"
SEQ="${SEQ:-5120}"

exec "$PY" -m mlx_lm.lora \
  --model base/gemma-4-e4b-clean \
  --train --data data-realistic \
  --adapter-path adapters/silver-realistic \
  --fine-tune-type lora --num-layers 8 --batch-size 1 \
  --iters "$ITERS" --max-seq-length "$SEQ" --learning-rate 5e-5 \
  --steps-per-report 20 --steps-per-eval 250 --val-batches 8 \
  --save-every 250 --grad-checkpoint
