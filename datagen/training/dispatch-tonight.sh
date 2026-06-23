#!/usr/bin/env bash
# Self-contained tonight dispatch (fired by launchd at 23:55, also safe to run by hand).
# 1) regenerate the multi-harness dataset from ALL collected real captures + gym
# 2) run the crash-recoverable night-run on it (chunked, resumable, packages + HF-uploads).
# Idempotent: on a recovery fire it SKIPS regen if a run is already in progress/done and just
# resumes night-run (so it never rewrites the dataset under a live trainer).
set -uo pipefail
export HOME="/Users/ignacylatka"
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
DG="$HOME/dev/argent-finetune-data/datagen"
log() { echo "[$(date '+%F %T')] dispatch: $*"; }
cd "$DG" || { echo "cannot cd $DG"; exit 1; }

GYM="${GYM:-2500}"; VALID="${VALID:-160}"
RUNS="training/runs"
if [ -f "$RUNS/multinight.progress" ] || [ -d "$RUNS/multinight.lock.d" ] || [ -f "$RUNS/multinight.done" ]; then
  log "run already in progress/done — skipping dataset regen, resuming night-run"
else
  log "regenerating data-multi (gym=$GYM + all real-capture)"
  node training/prepare-multi.ts --gym "$GYM" --real --valid "$VALID" --out data-multi 2>&1 | tail -8
  n=$(wc -l < training/data-multi/train.jsonl 2>/dev/null || echo 0)
  log "data-multi train rows: $n"
  [ "${n:-0}" -lt 200 ] && { log "FATAL: dataset too small ($n) — aborting before training"; exit 1; }
fi

cd training
export DATA=data-multi ADAPTER=adapters/silver-multi PFX=runs/multinight
export OLLAMA_NAME="silver:e4b" WORK="silver-multi"
export TOTAL_ITERS="${TOTAL_ITERS:-1500}" CHUNK="${CHUNK:-300}" SEQ="${SEQ:-4608}"
log "dispatching night-run (iters=$TOTAL_ITERS chunk=$CHUNK seq=$SEQ data=$DATA adapter=$ADAPTER)"
exec ./night-run.sh
