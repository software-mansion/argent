# Gemma 2 2B benchmark — does the gym teach anything?

This trains a small model (Gemma 2 2B, 4-bit) on the gym dataset and measures it
**by replaying its tool calls through the gym** — the same simulator + validators
the data is built with. The question isn't "did loss go down", it's "does a tiny
model trained on this data actually drive Argent: emit schema-valid calls, ground
its taps, and navigate to targets?" — vs the untrained base model.

Everything runs locally on Apple Silicon via MLX. Text-only (Gemma 2 2B has no
vision), so screenshots are the scene-caption text proxy; see "Vision" below.

## Pipeline

```bash
# 0) one-time: python venv with mlx-lm (from repo root)
python3.12 -m venv .venv && .venv/bin/pip install "mlx-lm>=0.20"

# 1) build the dataset (seed-disjoint train/valid/test, Gemma chat format)
node training/prepare.ts --n 2500 --valid 200 --test 250 --maxTokens 3400

# 2) LoRA fine-tune Gemma 2 2B 4-bit  (~1h for 600 iters on an M-series, 24GB)
ITERS=600 training/train.sh        # adapter -> training/adapters/gemma-argent

# 3) eval BASE vs TUNED through the gym (held-out seeds 5_000_000+)
node training/eval.ts --model mlx-community/gemma-2-2b-it-4bit --n 120 --label base
node training/eval.ts --model mlx-community/gemma-2-2b-it-4bit \
     --adapter training/adapters/gemma-argent --n 120 --label tuned

# results -> training/runs/eval-{base,tuned}.json
```

## What's measured (eval.ts)

Per held-out episode, the harness runs the model in a live agent loop against the
gym and scores:

- **nav_success_pct** — for navigation tasks (navigate / toggle / scroll-find /
  deep-link / hide-and-seek / login / android-setup / chromium-tabs), did the
  model navigate to the target screen and tap the **target element**? This is the
  headline navigation metric.
- **schema_valid_pct** — fraction of tool calls that validate against the real
  Argent JSON schemas (name known, required args, no unknowns, coords in [0,1]).
- **grounded_tap_pct** — fraction of taps whose coordinates fall on an element
  from the latest discovery result (i.e. not guessed).
- **policy_violations_per_ep**, **parse_fail / clean_finish %**, **avg_calls_per_ep**.

The gym and validators are the source of truth (TypeScript). A persistent Python
process (`serve.py`) only generates text; Node owns the loop and scoring.

## Why this is a fair test

- Eval seeds (5,000,000+) are disjoint from train (1+), valid (2,000,000+), and
  test (3,000,000+) — nothing scored was trained on.
- The model is offered the same tool-availability distribution as training (the
  task's needed tools plus distractors), so it still has to *select* and
  *sequence* correctly, ground its taps, and navigate.
- Greedy decoding, deterministic task generation → reproducible numbers.

## Files

- `prepare.ts` — gym trajectories → mlx-lm chat JSONL (`toGemmaMessages`).
- `serve.py` — persistent mlx-lm generation server (stdin/stdout JSONL).
- `eval.ts` — live agent loop through the gym + scoring.
- `train.sh` — mlx-lm LoRA wrapper. Full-sequence loss (not `--mask-prompt`,
  which would only train the last assistant turn — we want every tool-call turn).
- `data/`, `adapters/`, `runs/` — generated (gitignored).

## Vision (screenshots)

Gemma 2 2B is text-only, so the post-action screenshot is delivered as a scene
caption (`[screenshot] "<screen>" showing: …`). The user's point — that the
screenshot is the single most valuable navigation cue — is honored in text form,
and the hide-and-seek tasks train exploration off those captions. The upgrade to
real visual fluency is a **vision model** (e.g. Gemma 3 4B / Qwen2-VL 2B) fed
actual PNGs: the gym already holds the exact element layout, so a rasterizer that
draws the boxes+labels would emit ground-truth screenshots with no extra
labeling. That's the natural next step once the text benchmark validates the data.
