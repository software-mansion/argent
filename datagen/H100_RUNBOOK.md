# H100 run — silver long-context nav model

Everything below was de-risked on free hardware first. What's **proven** vs what's an **irreducible
H100-only unknown** is spelled out at the bottom — read that before paying.

## 0. Box
- 1× H100 **80GB**, recent PyTorch image (**torch ≥ 2.4**, CUDA 12.x), internet on.
- The script installs its own deps (transformers 5.5.0 pin + liger/bnb/peft/accelerate). It checks pip
  exit codes and aborts on a failed install, so you won't silently train on a broken stack.

## 1. Get the data onto the box → `./data/train.jsonl`
Either scp the local file (463 MB, 3272 rows):
```
scp datagen/kaggle/ds-longctx/train.jsonl  user@h100:~/run/data/train.jsonl
```
or pull from Kaggle on the box:
```
pip install kaggle && kaggle datasets download -d ignacytka/silver-nav-longctx --unzip -p ./data
```
(Or set `DATA_DIR=/path/to/dir` — the loader globs `**/train.jsonl` under it.)

## 2. Train
```
cd ~/run                       # h100_train.py + ./data/train.jsonl here
python h100_train.py           # default EPOCHS=2  (~1636 optim steps)
#   EPOCHS=1 python h100_train.py   # ~818 steps, ~half the cost, fine for a first pass
```
Budget: bs1 × grad_accum4 × 2 epochs ≈ **1636 steps**. Each step is a full forward/backward over a
~34K-token sequence (the masking only changes the *loss*, not the compute), so wall-clock is roughly
**1.5–3 h** depending on the H100. Checkpoints land in `./out/checkpoint-*` every 50 steps
(`save_total_limit=2`).

## 3. Watch the first ~5 steps — these confirm it's healthy
- `load` prints e.g. `train: 3272 rows | labeled .../... = ~1.0% | skipped_empty=0 truncated=0`.
  **labeled ≈ 1% and skipped/truncated = 0** ← completion-only masking is live and no row over-ran MAXLEN.
- `trainable params: 36,700,160` (r=16) and `versions: ... transformers=5.5.0`.
- Loss starts ~13–30 and **descends**; no NaN. (On the T4 dry-run the same pipeline went 30.2→4.7 with 0
  NaN grads — bf16 here is strictly more stable than that fp16 run.)
If step 1 errors or loss is NaN, kill immediately — you've spent pennies, not the whole run.

## 4. Get the adapter back
Saved to `./adapter` (LoRA only, ~150 MB) + `TRAIN_OK.txt`. Pull it to the Mac:
```
scp -r user@h100:~/run/adapter  datagen/fused/silver-longctx-adapter
```

## 5. Package locally (Mac) — proven path from v6
- Edit `datagen/local_merge.py`: point `ADAPTER` at `datagen/fused/silver-longctx-adapter`, set
  `MERGED` to `fused/silver-longctx-merged`.
- Then mirror `package-v6.sh` (peft-merge fp16 → `convert_hf_to_gguf.py` auto-extracts the text LM →
  `llama-quantize Q6_K` → `ollama create silver-longctx:e4b-text-Q6-K`). The Modelfile must keep
  `RENDERER gemma4` + `PARSER gemma4` + `num_ctx 131072`.

## 6. Verify (the test that catches the schema-as-args bug)
```
python3 datagen/verify_realpath.py silver-longctx:e4b-text-Q6-K
```
Hits ollama `/v1/messages` with a real provider prompt + the full 67-tool catalog (`mcp__argent__*`
names — that convention is in the training mix) and a multi-step nav scenario. Pass = **✅ real args**
(not the param schema) + **name ✅** (valid catalog tool). Compare against `silver-v6:e4b-text-Q6-K`,
which passed at ~18K but broke at ~55K — the whole point of this run is to hold up at full-harness scale.
Also eyeball a multi-step trajectory in ollama to confirm the served gemma4 grouping matches training
(the one format detail only checkable post-deploy).

---
## Proven before paying (hard evidence, this session)
- **Token fit**: all 3272 rows tokenized with the real gemma-4-E4B tokenizer → max **38,959 < 40,960**,
  0 truncations, 0 destroyed labels.
- **Masking correctness**: assistant-only mask verified on **all 3272 rows** — every tool-call + summary
  labeled, zero tool-result/system leakage, zero empty masks. (`assistant_only_loss=True` was a trap: the
  gemma4 template lacks `{% generation %}`, so it returns empty masks → would train on nothing.)
- **The new pipeline on real GPU** (silver-plumbtest, T4): transformers.Trainer + pre-tokenized masked
  labels + custom collator + custom inner-text Liger CE → **PLUMB_OK**, loss 30.2→4.7, valid_labels ~5%
  (masking live), **0 NaN/inf grads**, 9.6 GB peak, trainable 36.7M. Dep combo (transformers 5.5.0 +
  liger + bnb + peft + adamw_8bit) installs and runs.
- **Tool naming**: the data carries all 4 harness conventions (`argent_…`, `mcp__argent__…`, de-dashed,
  `mcp_argent_…`); the serve path's `mcp__argent__list-devices` is in-distribution.

## Irreducible H100-only unknowns (can't test on Kaggle's no-bf16 GPUs)
- **bf16 execution** (first time on the paid box). It's the *same code* the T4 ran under autocast, minus
  every fp16 hack — bf16 has fp32's exponent range, so it's strictly more stable. Surfaces in step 1 if wrong.
- **40K-context memory on 80 GB**: budgeted ~35–55 GB (4-bit weights + bf16 PLE on-GPU + 40K activations
  with grad-ckpt + Liger CE chunk). Comfortable, but first real measurement is on the box.
