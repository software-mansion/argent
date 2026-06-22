#!/usr/bin/env bash
# Unattended overnight pipeline: train the corrected silver (recoverable) -> package.
# Scheduled via launchd (see com.silver.nightrun.plist; fires 00:00 and a 04:00 recovery).
# Survives a crash 3 hours in: training runs in CHUNKS, each chunk resumes from the latest
# saved weights, a progress file records completed chunks, the LaunchAgent re-fires so a
# whole-process death / reboot still resumes, and a stale-aware lock prevents double-runs.
#
#   DRY_RUN=1 ./night-run.sh     # fast end-to-end test (tiny train, skips packaging)
#   ./night-run.sh               # real run
#
# Idempotent: re-running resumes from the progress file and skips finished steps.
set -uo pipefail   # NOT -e: failures are handled explicitly so one step can't kill the run

# ---- environment (launchd gives a minimal PATH; set everything explicitly) ----
export HOME="/Users/ignacylatka"
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HERE="$HOME/dev/argent-finetune-data/datagen/training"
PY="$HOME/dev/argent-finetune-data/.venv/bin/python"
PLIST="$HOME/Library/LaunchAgents/com.silver.nightrun.plist"

DRY_RUN="${DRY_RUN:-0}"
if [ "$DRY_RUN" = "1" ]; then
  TOTAL_ITERS="${TOTAL_ITERS:-4}"; CHUNK="${CHUNK:-2}"; SEQ=512; DATA="data-dryrun"
  ADAPTER="adapters/_dryrun"; PFX="runs/_dryrun"
else
  TOTAL_ITERS="${TOTAL_ITERS:-1200}"; CHUNK="${CHUNK:-300}"; SEQ="${SEQ:-4608}"; DATA="data-realistic"
  ADAPTER="adapters/silver-realistic"; PFX="runs/nightrun"
fi
PROGRESS="$PFX.progress"; DONE_MARKER="$PFX.done"; LOCKDIR="$PFX.lock.d"

ts()  { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*"; }

disable_agent() {  # one-shot: stop the LaunchAgent re-firing once finished (real run only)
  [ "$DRY_RUN" = "1" ] && return 0
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST" 2>/dev/null || true
  log "LaunchAgent disabled"
}

release_lock() { [ "${LOCK_HELD:-0}" = "1" ] && rm -rf "$LOCKDIR" 2>/dev/null; }  # rm -rf: lockdir holds a pid file

acquire_lock() {  # mkdir is atomic on macOS (no flock); detect & steal a stale lock
  if mkdir "$LOCKDIR" 2>/dev/null; then echo $$ >"$LOCKDIR/pid"; LOCK_HELD=1; return 0; fi
  local pid; pid=$(cat "$LOCKDIR/pid" 2>/dev/null || echo "")
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 1; fi  # live holder
  log "stale lock (pid '${pid:-?}' dead) — reclaiming"
  rm -rf "$LOCKDIR"; mkdir "$LOCKDIR" 2>/dev/null && { echo $$ >"$LOCKDIR/pid"; LOCK_HELD=1; return 0; }
  return 1
}

train_chunk() {
  local resume=""
  [ -f "$ADAPTER/adapters.safetensors" ] && resume="--resume-adapter-file $ADAPTER/adapters.safetensors"
  "$PY" -m mlx_lm.lora \
    --model base/gemma-4-e4b-clean --train --data "$DATA" \
    --adapter-path "$ADAPTER" --fine-tune-type lora \
    --num-layers 8 --batch-size 1 --iters "$CHUNK" --max-seq-length "$SEQ" \
    --learning-rate 5e-5 --steps-per-report 20 --steps-per-eval 999999 \
    --val-batches 1 --save-every "$CHUNK" --grad-checkpoint $resume
}

# ================= main =================
cd "$HERE" || { echo "FATAL: cannot cd $HERE"; exit 1; }
mkdir -p runs adapters

if ! acquire_lock; then echo "[$(ts)] another instance holds the lock — exiting"; exit 0; fi
trap 'release_lock' EXIT

LOGFILE="$PFX-$(date +%Y%m%d).log"
exec >>"$LOGFILE" 2>&1
log "=== NIGHT RUN START (DRY_RUN=$DRY_RUN total=$TOTAL_ITERS chunk=$CHUNK seq=$SEQ) ==="

if [ -f "$DONE_MARKER" ]; then log "done-marker present — nothing to do"; disable_agent; exit 0; fi

# keep the machine awake for the whole run (real run only)
if [ "$DRY_RUN" != "1" ]; then caffeinate -i -m -w $$ & log "caffeinate armed (pid $!)"; fi

# preflight
pkill -9 -f "llama-server" 2>/dev/null || true
pkill -9 -f "ollama serve"  2>/dev/null || true
sleep 2
if [ "$DRY_RUN" = "1" ]; then
  mkdir -p "$DATA"
  head -n 8 data-realistic/train.jsonl >"$DATA/train.jsonl" 2>/dev/null
  head -n 4 data-realistic/valid.jsonl >"$DATA/valid.jsonl" 2>/dev/null
fi
for f in "base/gemma-4-e4b-clean/config.json" "$DATA/train.jsonl" "$DATA/valid.jsonl"; do
  [ -s "$f" ] || { log "FATAL: missing/empty $f"; exit 1; }
done
[ -x "$PY" ] || { log "FATAL: python not executable at $PY"; exit 1; }

# ---- TRAIN in resumable chunks ----
done_chunks=$(cat "$PROGRESS" 2>/dev/null || echo 0)
n_chunks=$(( (TOTAL_ITERS + CHUNK - 1) / CHUNK ))
log "training: $n_chunks chunks x $CHUNK iters ($done_chunks already done)"
c=$((done_chunks + 1))
while [ "$c" -le "$n_chunks" ]; do
  ok=0
  for attempt in 1 2 3; do
    log "chunk $c/$n_chunks attempt $attempt (resume: $([ -f "$ADAPTER/adapters.safetensors" ] && echo yes || echo no))"
    if train_chunk; then ok=1; break; fi
    log "chunk $c attempt $attempt FAILED; freeing GPU, retrying"
    pkill -9 -f "mlx_lm.lora" 2>/dev/null || true; sleep 15
  done
  [ "$ok" = "1" ] || { log "FATAL: chunk $c failed after 3 attempts"; exit 1; }
  echo "$c" >"$PROGRESS"
  cp "$ADAPTER/adapters.safetensors" "$ADAPTER/checkpoint-chunk$c.safetensors" 2>/dev/null || true
  log "chunk $c done ($(( c * CHUNK )) iters)"
  c=$((c + 1))
done
log "training complete -> $ADAPTER/adapters.safetensors"

# ---- PACKAGE (skipped in dry-run; package-native.sh is proven separately) ----
if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN: skipping packaging"
elif ./package-native.sh "$ADAPTER" silver-realistic:e4b silver-realistic; then
  log "packaged silver-realistic:e4b OK"
else
  log "WARNING: packaging failed — adapter safe at $ADAPTER (package manually in the morning)"
fi

touch "$DONE_MARKER"
log "=== NIGHT RUN DONE ==="
disable_agent
exit 0
