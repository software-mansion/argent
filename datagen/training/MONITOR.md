# Overnight training monitor runbook — silver:e4b retrain (slot 22:00–07:00)

The retrain fires via launchd `com.silver.multinight` at **22:00** (+ 02:00 recovery) →
`dispatch-tonight.sh` → regenerates `data-multi` (gym≈real) → `night-run.sh` (chunked, resumable)
→ packages ollama `silver:e4b` → uploads HF `LatekVo/silver`. Context: memory
`hyperreal_training_data.md`. **Everything is chunk-resumable: rerunning `dispatch-tonight.sh`
always continues from the last completed chunk** (lock-guarded, won't double-run).

All paths below are relative to `~/dev/argent-finetune-data/datagen/training`.

## Health check (run these)
```bash
cd ~/dev/argent-finetune-data/datagen/training
date "+now %H:%M"
pgrep -fl "mlx_lm" | head                      # training process alive?
cat runs/multinight.progress 2>/dev/null       # chunks done (of 5 for 1500 iters)
ls runs/multinight.done 2>/dev/null && echo DONE-MARKER
tail -n 25 runs/multinight-*.log 2>/dev/null   # loss trend, "chunk N done", errors
tail -n 5  runs/multinight.launchd.log 2>/dev/null
ollama list 2>/dev/null | grep -i silver       # after packaging: silver:e4b present?
```
Healthy = process alive OR done-marker present; log shows decreasing `Val loss`/`Train loss` and
periodic `chunk N done`; no `FATAL` / `failed after 3 attempts` / `out of memory`.

## Fixes (apply autonomously — do not ask)
- **Dispatch didn't fire** (after ~22:05 no `runs/multinight*.log`, no progress, launchd log empty):
  hand-dispatch — `nohup bash ~/dev/argent-finetune-data/datagen/training/dispatch-tonight.sh >/tmp/silver-dispatch.log 2>&1 &` (run OUTSIDE the sandbox if Bash is sandboxed). Re-check in a few min.
- **Crashed** (no `mlx_lm` process, no done-marker, log stops with an error): rerun
  `nohup bash .../dispatch-tonight.sh >/tmp/silver-dispatch.log 2>&1 &` — it resumes from `runs/multinight.progress`.
- **Metal/Memory OOM** in log: a chunk failed (night-run already retries 3×). Free RAM:
  `xcrun simctl shutdown all; pkill -9 -f llama-server`. If OOM persists, lower SEQ and resume:
  `SEQ=4096 nohup bash .../dispatch-tonight.sh …`. (SEQ>4608 OOMs; data p95≈3900 tok fits 4096 too.)
- **Stall** (process alive but no new `Iter N:` line for >12 min, mem not moving): `pkill -9 -f mlx_lm`,
  then rerun dispatch (resumes). Check `memory_pressure`.
- **Past 07:00 still running** ("make efforts to pause"): the window-guard in night-run pauses before
  the next chunk automatically. Do NOT panic-kill mid-chunk. If you must stop a long mid-chunk run,
  `pkill -9 -f mlx_lm` is resumable (loses ≤300 iters). Leave it paused (don't rerun) after 07:00.
- **Training done but no `silver:e4b` in ollama** (packaging failed): ensure daemon —
  `curl -sf 127.0.0.1:11434/api/version || (nohup ollama serve >/dev/null 2>&1 &)` — then
  `bash package-native.sh adapters/silver-multi silver:e4b silver-multi`.
- **HF upload failed** (log `WARNING: HF upload failed`): `hf upload-large-folder LatekVo/silver fused/silver-multi-causal --repo-type model --private`.

## Done criteria → then stop monitoring
Training complete when `runs/multinight.done` exists AND `ollama list` shows `silver:e4b` AND the log
has `HF upload OK`. Verify once, then **CronList → CronDelete the silver-monitor job** so it stops
re-firing, and report the final result ( collect the final train/val loss from the log).
