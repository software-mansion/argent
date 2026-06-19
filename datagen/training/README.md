# Gemma 2 2B benchmark — does the gym teach anything?

This trains a small model (Gemma 2 2B, 4-bit) on the gym dataset and measures it
**by replaying its tool calls through the gym** — the same simulator + validators
the data is built with. The question isn't "did loss go down", it's "does a tiny
model trained on this data actually drive Argent: emit schema-valid calls, ground
its taps, and navigate to targets?" — vs the untrained base model.

Everything runs locally on Apple Silicon via MLX. Text-only (Gemma 2 2B has no
vision), so screenshots are the scene-caption text proxy; see "Vision" below.

## Result (this run)

LoRA fine-tune of `mlx-community/gemma-2-2b-it-4bit` on 2,500 gym trajectories
(500 iters, batch 1, seq 2600, LR 5e-5; val loss 2.32 → 0.064), evaluated through
the gym on **120 held-out tasks** (seeds 5,000,000+, greedy). Full numbers in
`results/RESULTS.md`.

| metric                             | base   | gym-tuned |
| ---------------------------------- | ------ | --------- |
| Navigation success                 | **0%** | **44.1%** |
| Schema-valid tool calls            | **0%** | **99.2%** |
| Grounded taps (coords not guessed) | **0%** | **97.2%** |
| Tool calls / episode               | 0      | 7.3       |
| Episodes ending with no attempt    | 100%   | 31.7%     |

The base model never emits a tool call — it just chats (0% everywhere). After
training on the gym data, a 2B model issues schema-valid, coordinate-grounded
tool calls and navigates to the target on ~44% of held-out tasks. By kind:
`login 6/6`, `toggle 6/9`, `deep-link 4/8`, `hide-and-seek 5/12`,
`navigate-tap 6/19`, `android-setup 2/3`. **Honest weakness: `scroll-find 0/9`** —
the model didn't learn the scroll-to-reveal-then-tap pattern (a clear next-data
target: more scroll demonstrations / a scroll-specific reward). The takeaway: the
gym data demonstrably teaches Argent tool-use to a tiny model, and the eval is the
same gym-replay recipe the $500 / $50k models will use.

## Pipeline

```bash
# 0) one-time: python venv with mlx-lm (from repo root)
python3.12 -m venv .venv && .venv/bin/pip install "mlx-lm>=0.20"

# 1) build the dataset (seed-disjoint train/valid/test, Gemma chat format)
node training/prepare.ts --n 2500 --valid 150 --test 150 --maxTokens 2500

# 2) LoRA fine-tune Gemma 2 2B 4-bit  (~50 min for 500 iters on an M-series, 24GB)
ITERS=500 training/train.sh        # adapter -> training/adapters/gemma-argent

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
  task's needed tools plus distractors), so it still has to _select_ and
  _sequence_ correctly, ground its taps, and navigate.
- Greedy decoding, deterministic task generation → reproducible numbers.

## Files

- `prepare.ts` — gym trajectories → mlx-lm chat JSONL (`toGemmaMessages`).
- `serve.py` — persistent mlx-lm generation server (stdin/stdout JSONL).
- `eval.ts` — live agent loop through the gym + scoring.
- `train.sh` — mlx-lm LoRA wrapper. Full-sequence loss (not `--mask-prompt`,
  which would only train the last assistant turn — we want every tool-call turn).
- `data/`, `adapters/`, `runs/` — generated (gitignored).

## Run it in Ollama (`silver:2b`)

Fuse the LoRA adapter into the base, dequantize, and import into Ollama:

```bash
# fuse adapter -> dequantized HF model (MLX can't GGUF-export gemma2, that's fine)
.venv/bin/python -m mlx_lm fuse \
  --model mlx-community/gemma-2-2b-it-4bit \
  --adapter-path training/adapters/gemma-argent \
  --save-path training/fused/argent-silver --dequantize
# MLX's fuse omits the SentencePiece model — copy it in or Ollama's tokenizer breaks:
cp ~/.cache/huggingface/hub/models--mlx-community--gemma-2-2b-it-4bit/snapshots/*/tokenizer.model \
   training/fused/argent-silver/
node training/make-modelfile.ts                          # writes training/fused/Modelfile
ollama create silver:2b -f training/fused/Modelfile -q q4_K_M
```

Then chat — the Argent policy + a 16-tool list are baked into the Modelfile, so
just give it a task:

```bash
ollama run silver:2b "In the Settings simulator, go to General and tap About."
# -> "First, let me see what devices are available."
#    <tool_call>{"name":"list-devices","arguments":{}}</tool_call>
```

It's a multi-turn agent: paste the `<tool_response>` back and it issues the next
action (e.g. reads the udid from the device list and calls `launch-app` with the
right bundle id). Two import gotchas, both handled by `make-modelfile.ts`:

- **`tokenizer.model`** must be copied into the fused dir or Ollama emits
  `[UNK_BYTE_…]` garbage (MLX's fuse only writes the fast `tokenizer.json`).
- **`<bos>`** must be in the template literally — Gemma only emits tool calls
  with a BOS token, and Ollama does not auto-add it for this imported model
  (verified: without it the model chats; with it, it tool-calls).

It's a 2B, so expect the held-out quality from `results/` (~44% nav, 99%
schema-valid) — good enough to feel the behavior, not a production agent.

## Vision (screenshots)

Gemma 2 2B is text-only, so the post-action screenshot is delivered as a scene
caption (`[screenshot] "<screen>" showing: …`). The user's point — that the
screenshot is the single most valuable navigation cue — is honored in text form,
and the hide-and-seek tasks train exploration off those captions. The upgrade to
real visual fluency is a **vision model** (e.g. Gemma 3 4B / Qwen2-VL 2B) fed
actual PNGs: the gym already holds the exact element layout, so a rasterizer that
draws the boxes+labels would emit ground-truth screenshots with no extra
labeling. That's the natural next step once the text benchmark validates the data.

## Gemma 4 E4B (`silver:e4b`)

The same pipeline scaled to **Gemma 4 E4B** (effective-4B, ~7.46B params) on the
*identical* 2,500-trajectory dataset — a bigger-model run to confirm the gym
teaches at scale. Recipe held constant vs the 2B (8 LoRA layers, batch 1, LR 5e-5,
500 iters); only `MAXSEQ` changed (the gemma4 chat template is ~30% more verbose
than gemma2's, so 46% of the same trajectories overflow 2600 tokens → raised to
3500). Validation loss **2.57 → 0.062**. Uploaded to `LatekVo/silver`.

```bash
# 0) clean base: the mlx-community gemma-4 E4B 4-bit quant ships 126 redundant
#    shared-KV tensors that mlx_lm's strict load rejects; re-save the real params.
.venv/bin/python training/clean-base.py \
  --repo mlx-community/gemma-4-e4b-it-4bit --out training/base/gemma-4-e4b-clean

# 1) data (reuse the 2B's; chat-format JSONL is model-agnostic) + 2) train
MODEL=$PWD/training/base/gemma-4-e4b-clean ITERS=500 MAXSEQ=3500 \
  ADAPTER=adapters/gemma4-e4b-argent training/train.sh

# 3) fuse + dequantize, then rewrite as a text-only Gemma4ForCausalLM
.venv/bin/python -m mlx_lm fuse --model training/base/gemma-4-e4b-clean \
  --adapter-path training/adapters/gemma4-e4b-argent \
  --save-path training/fused/silver-e4b --dequantize
.venv/bin/python training/to-causal.py   # -> training/fused/silver-e4b-causal
```

### Ollama: convert with llama.cpp, not Ollama's converter

**Ollama 0.30's gemma4 *converter* is broken** for a text-only checkpoint (its
`Gemma4ForConditionalGeneration` path drops `token_embd`; its `Gemma4ForCausalLM`
path crashes mid-tensor-write) — but its gemma4 *runtime* is fine (the official
`gemma4:e4b` runs). So convert with **llama.cpp's** mature converter, then *import*
the GGUF (no Ollama-side conversion):

```bash
python convert_hf_to_gguf.py training/fused/silver-e4b-causal \
  --outfile training/fused/silver-e4b.f16.gguf --outtype f16   # llama.cpp
FLAVOR=gemma4 node training/make-modelfile.ts                  # -> fused/Modelfile.e4b
ollama create silver:e4b -q q4_K_M -f training/fused/Modelfile.e4b
```

`silver:e4b` (5.3 GB, q4_K_M) then runs like `silver:2b` — `ollama run silver:e4b
"<task>"`. The Argent preamble is in `SYSTEM`; Ollama's native `RENDERER gemma4`
(auto-assigned) handles bos/turns, so no baked template is needed (unlike the 2B).
Multi-turn verified: it reads the udid from a pasted `<tool_response>` and issues
`launch-app`. Gotchas: see `clean-base.py` (redundant KV keys), `to-causal.py`
(text-only layout so the converter maps `token_embd`), and the converter note above.

### Eval (e4b)

Same gym-replay recipe, held-out seeds 5,000,000+. Numbers in `results/`.
