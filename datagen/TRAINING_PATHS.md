# Training paths — gemma (proven) & ornith (experimental)

One kernel (`h100_train.py`), one dataset format, N base models. The training data (`train.jsonl` of raw
`{messages, tools}`) is **base-agnostic** — each base's own chat template renders it at load time. Only a
handful of things differ per base, all captured in the `CONFIGS` dict at the top of `h100_train.py`.
Select with `BASE=gemma` (default) or `BASE=ornith`. The *why* behind the recipe lives in
`../FINETUNE_RECIPE.md`; this file is the *how to run both paths*.

## What is shared vs per-base
| Shared (identical both paths) | Per-base (in `CONFIGS`) |
|---|---|
| dataset (`{messages,tools}` jsonl) | `model_id`, `model_class` (multimodal vs causal_lm) |
| completion-only mask *logic* | mask *markers* (turn/tool_call/tool_response delimiters) |
| QLoRA hyperparams (r16, lr2e-4, cosine, bs1×ga4, MAXLEN, steps) | LoRA `target_modules` regex |
| Liger fused-linear CE | which submodule is the decoder + unembedding (`loss_mode`) |
| completion-only, bf16, 4-bit nf4 | attention path (gemma3n hybrid flash+xformers vs plain flash) |
| resume-from-checkpoint | RENDERER/PARSER + NUM_CTX at package time |

## GEMMA path (control — proven from silver v5→v10; DO NOT edit its `CONFIGS["gemma"]` entry)
```bash
# on an 80GB A100/H100 pod, data at ./data/{train,valid}.jsonl
DATA_DIR=/root/run/data MAXLEN=65536 MAX_STEPS=300 SAVE_TOTAL_LIMIT=10 REORDER_THOUGHT=1 \
  python h100_train.py                          # BASE defaults to gemma
# package -> ollama (gemma defaults, so just WORK+NAME):
WORK=silver-v10b NAME=silver-v10b:e4b bash package.sh
```
Env pins for the gemma3n kernel (get these wrong and flash_attn.so breaks — see
`silver_train_env_pins` memory): torch **2.6.0+cu124**, flash_attn 2.7.4 (torch2.6 wheel), xformers
0.0.29.post3, transformers 5.5.0, peft 0.19.1. **Never `pip install unsloth`** (drags torch→2.10) and
**remove `torchao`** (breaks under 2.6, masquerades as a Bloom import error).

## ORNITH path (experimental — 9B dense text-only)
`ornith:9b-q4_K_M` is an ollama SERVE quant. **Training needs ornith's fp16/bf16 HF safetensors**, not the
GGUF (QLoRA re-quantizes to 4-bit nf4 at load). Steps:

**0. Gate: 0-shot benchmark raw ornith first.** Fine-tuning sharpens, it can't create the skill. If raw
ornith is ~0% at device nav, stop. gemma-e4b's ~35% zero-shot headroom is *why* silver-v10 worked.

**1. Discover ornith's template markers** (the mask keys off them; wrong markers → empty mask → 0 rows):
```bash
BASE=ornith BASE_MODEL=<hf/ornith-9b> DISCOVER=1 python h100_train.py
```
This prints ornith's rendered chat template (with a demo tool call). Read off its turn / tool_call /
tool_response delimiters. **Confirm the template actually renders `tools`** — if it doesn't, ornith can't
be trained on our tool-calling data as-is (you'd need a template that supports tools).

**2. Set the ornith knobs** (env; defaults assume a Llama/Qwen/Mistral-family arch):
```bash
export BASE=ornith
export BASE_MODEL=<hf/ornith-9b>            # REQUIRED: fp16 safetensors repo, NOT the GGUF
# LoRA targets: default `.*\.(q|k|v|o|gate|up|down)_proj$` (no `language_model.`); override if names differ
# export LORA_TARGETS='...'
# TRUST_REMOTE_CODE=1 if ornith ships custom modeling code
# mask markers from step 1 (REQUIRED — no safe default; kernel fails fast if unset):
export MASK_MODEL_BLOCK_RE='<open>(.*?)(?:<close>|\Z)'   # decoder-turn open .. close|EOF, group(1)=body
export MASK_TOOL_RESP_RE='<tr_open>.*?<tr_close>'        # environment tool_response span to EXCLUDE
export MASK_TURN_RE='(<open>)(.*?)(<close>|\Z)'          # same as block, but 3 capture groups (head,body,tail)
export MASK_TURN_CLOSE='<close>'                         # turn-close literal (endswith + reorder)
export MASK_TOOLRESP_CLOSE='<tr_close>'                  # tool_response close literal (reorder rfind)
export MASK_TOOLCALL_CLOSE='<tc_close>'                  # tool_call close literal (reorder rfind)
```

**3. Cheap validation BEFORE the paid run** — confirm the mask is non-empty & correct on a few rows.
The kernel already fails fast if 0 rows survive, but sanity-check the labeled fraction is ~1–3% and that
tool-call names + summaries land in the labeled text (mirror `test_mask.py` for ornith's markers).

**4. Train** (same hyperparams; note 9B ≈ 2× E4B compute/memory — expect slower steps, heavier KV):
```bash
DATA_DIR=/root/run/data MAXLEN=65536 MAX_STEPS=300 REORDER_THOUGHT=1 python h100_train.py
```
Attention: the gemma3n flash+xformers hybrid is **skipped** for ornith (`hybrid_attn:false`) — it uses
transformers' real `flash_attention_2`. If ornith's arch isn't flash-friendly, set `ATTN_IMPL=sdpa`.

**5. Package** — ornith is NOT gemma4; set its renderer/parser/ctx:
```bash
WORK=ornith-v1 NAME=ornith-v1:9b MODEL_CLASS=causal_lm BASE_MODEL=<hf/ornith-9b> \
  RENDERER=<ornith-renderer> PARSER=<ornith-parser> NUM_CTX=<ornith-ctx> QUANT=Q4_K_M \
  bash package.sh
```

**6. Benchmark identically** to silver-v10 (same real Bluesky tasks, same harness) so the only variable is
the base. Add a cell to `~/dev/silver-bench` and require it to beat the base you measured in step 0.

## Fail-fast guardrails built into the kernel
- Unknown `BASE` → hard error.
- `BASE=ornith` without `BASE_MODEL` → hard error (don't accidentally train gemma under the ornith label).
- Missing mask markers → hard error with the DISCOVER hint.
- 0 usable rows after masking → hard error (markers don't match the template).
These exist so a misconfigured new base fails in seconds, not after a multi-minute model load or a paid step.

## Safety
- **Never edit `CONFIGS["gemma"]`** — it's the byte-preserved control (verified equal to the v5→v10 values).
- Push checkpoints to HF **and verify the bytes** before any `pod stop` — pods with `volumeInGb:0` wipe
  their disk on stop (we lost the v10 ckpt-300 raw adapter that way; see `runpod_ephemeral_disk_loss` memory).
