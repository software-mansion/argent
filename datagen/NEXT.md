# NEXT — super-important TODO (paused 2026-06-24, waiting on compute resources)

## ⛔ THE BLOCKER: we need GPU/TPU compute to retrain silver

Local Apple-Silicon/Metal box caps training at **SEQ 4608** (OOMs above). Diagnosis (06-24)
proved a **~30× train/inference distribution gap**: real OpenCode harness = full 67-tool VERBOSE
catalog + 32KB system prompt + uncapped describes = **~42K tokens on turn 1** (measured via
`prompt_eval_count`), but we trained on **~1.4K-token** rows (lean 8-tool compact surface,
ARGENT_SYSTEM_PROMPT 809c, `capObservations` 1000c, drop >9000c). The model learned the harness's
SHAPE (junk/naming/describe→tap loop) but operates fragile in the live fat distribution — under
sampling (temp>0) it produced wrong bundleId (`com.apple.Settings` vs correct `com.apple.Preferences`)
and a hallucinated tool (`argent_app-switch`). Knowledge IS present (gym demo'd Preferences 296×) and
controlled temp-0 replay gets it right — so the fix is: **train on the real distribution at long seq
+ serve at higher precision (q6/q8) + pin temp 0 + prune observations in the harness.** None of that
is possible on the local box. **→ need ≥1×80GB GPU (or free cloud equiv).** (See `MEMORY.md` →
hyperreal_training_data for full detail.)

**IN PROGRESS:** researching FREE / no-personal-credit-card cloud compute (Colab, Kaggle, SageMaker
StudioLab, HF DLCs/AutoTrain/Spaces, Azure, Vertex, Lightning, Paperspace, Modal, …). This is a
CORPORATE project — do not use a personal card for trial credits.

## End goal (user, 06-24)
A **128K-context** model that **runs on a Mac** and **smoothly NAVIGATES** an app (tap/swipe/describe
loops). No debugging/coding/profiling for now — navigation only.

## Acceptance test (observable bar)
Re-run the exact failing transcript: "boot any device, navigate into settings, then privacy settings"
→ model boots a valid device, launches Settings via **`com.apple.Preferences`**, reaches Privacy, with
**no hallucinated tools**, under sampling (temp>0). Today silver fails this in the live OpenCode harness.

## ⏸ PAUSED sub-task: q6_K + 128K repackaging of silver:e4b (user-decided, paused for resources)
- Decision: serve at **q6_K** (q4 was degrading factual recall) + **num_ctx 131072** (expose full
  native 128K — do NOT bake an artificial ceiling; harness prunes to operate small).
- **Gotcha (resolved in script):** ollama's `create -q` does NOT support Q6_K (only Q4_K_*/Q8_0).
  Must quantize with **llama.cpp `llama-quantize … Q6_K`** then `ollama create -f` (no -q).
  `package-native.sh` step 4 is already fixed to do this two-step. `llama.cpp` installed via brew.
- Source f16 GGUF: `datagen/training/fused/silver-multi.f16.gguf` (14G). To resume locally:
  `cd datagen/training && llama-quantize fused/silver-multi.f16.gguf fused/silver-multi.Q6_K.gguf Q6_K`
  then import with the Modelfile (TEMPLATE/RENDERER/PARSER gemma4, num_ctx 131072, temperature 0).

## Compute options (researched 06-24, verified vs 2026 sources)

**THE decisive gotcha (any free-T4 path):** Gemma 3n + Tesla **T4 fp16 = NaN/inf** (Conv2D weights
overflow fp16's 65504; T4 has no bf16). → MUST use **Unsloth** (patches this) or manually autocast.
Vanilla HF/peft and Google's own notebooks will produce garbage on a T4. QLoRA is CUDA-only
(bitsandbytes) → TPUs are useless for QLoRA. Freeze vision/audio towers (text layers only).

**Feasibility (QLoRA, bs1, grad-ckpt):** free **T4 16GB → ~8K seq w/ Unsloth (4K vanilla), 16K tight**;
**32K needs ≥24GB**. Our acceptable 4–8K fits free T4; ideal 16–32K needs Unsloth-on-T4 (→16K) or 24GB+.

| Platform | Free / no-card | HW | Automatable | Seq | Verdict |
|---|---|---|---|---|---|
| **Kaggle Notebooks** | free, no card (1× SMS/ID) | 16GB T4/P100, ~30 GPU-h/wk | **YES headless** (`kaggle kernels push`) | 4–8K | **best free + automatable** |
| **Colab (free)** | free, no card | 16GB T4 (flaky, 90min idle) | browser-only (ToS bans headless) | 4–8K | great for a manual one-off |
| **Modal** | $30/mo credits, no card to start | **A100-40/80, L40S** | YES (CLI/SDK) | **up to 32K** | best no-card for big VRAM/32K |
| **Lightning AI** | 15 cr/mo, no card (phone) | 24GB L4/A10G/L40S | yes (sdk) | →32K | viable, 4h windows |
| **SageMaker Studio Lab** | free, no card | 16GB T4, 4h/day | browser-only | 4–8K | OK, daily cap |
| **RunPod / vast.ai** (paid) | prepaid $5–10 (corp card OR crypto, no recurring) | 4090-24/A40-48/A100 | YES (cli/sdk) | →32K | **~$1–2/run** cheap fallback |
| Azure (trial/student), HF AutoTrain/Spaces/DLCs, Vertex, AI Studio, Together, Paperspace | ❌ card-gated / GPU-blocked / inference-only / can't load 3n | — | — | — | rejected |

**Plan:** base on **Unsloth's `Gemma3N_(4B)-Conversational` notebook** (handles the T4 NaN) → swap in
our JSONL {messages,tools} nav data + gemma4 template → `max_seq_length 8192`, QLoRA, freeze
vision/audio → download LoRA adapter → merge + Q6_K locally (package-native.sh two-step) → ollama on
Mac. Prototype on **Kaggle** (automatable) or click-through **Colab** now; escalate to **Modal/RunPod**
only for a clean 16–32K run. Port MLX→Unsloth(PyTorch); data format already compatible.

**Kaggle setup (06-24):** CLI 2.2.2 via pipx; authed as account **`ignacytka`** through the NEW
`KGAT_` token format → `~/.kaggle/access_token` (NOT kaggle.json username+key; env var is
`KAGGLE_API_TOKEN`). `google/gemma-3n` is hosted on Kaggle (model id 317146). **Reality check:** free
Kaggle T4 caps at ~8K seq — enough to retrain a BETTER LEAN model (q6 + more iters + base bake-off +
modest seq bump) but NOT the full 42K fat distribution. Closing the real fat-distribution gap (16–32K)
still needs a 24GB+ card → Modal/RunPod escalation. Uploaded Kaggle resources MUST be PRIVATE (corp data).

**Kaggle GPU gotcha (06-24, SOLVED):** `enable_gpu:true` alone defaults to **Tesla P100 (CC 6.0)** —
which (a) modern/stock Kaggle torch no longer supports (sm_60 dropped) and (b) Unsloth refuses
(needs CC≥7.0). FIX: set kernel-metadata **`"machine_shape": "NvidiaTeslaT4"`** to force a T4 (CC 7.5).
Valid machine_shape values: `NvidiaTeslaT4`, `NvidiaTeslaP100`, `Tpu1VmV38`. Always include a fast
`torch.cuda.get_device_capability()` guard in the kernel so a wrong GPU bails in seconds. Real kernel
uses STOCK torch (no cu128 reinstall) + the Gemma4 recipe pins (transformers==5.5.0).

**REAL RUN v1 (06-24, LAUNCHED):** rich dataset `training/data-multi-rich-fit` (8916 train / 747 valid,
mean ~5940 tok, all ≤8192) via `prepare-multi.ts --rich` (full tool descriptions + 13-tool RICH_SURFACE,
obs cap 2500; Python token-filter via gemma-4 tokenizer drops the 3.8% over 8192) → uploaded **private
`ignacytka/silver-nav-rich`** → training kernel **`ignacytka/silver-train`** (gemma-4-E4B QLoRA r16,
max_seq 8192, fp16, max_steps 600 for v1, T4 forced via machine_shape) RUNNING. Kernel evals IN-KERNEL
on the boot→Settings bug (log shows if it emits `com.apple.Preferences`). Artifacts:
`datagen/kaggle/{smoke,smoke2,train}` (kernels), `datagen/kaggle/ref` (Unsloth recipes). **Pending:**
pull adapter → LOCAL merge+GGUF+Q6_K→ollama (Unsloth adapter is HF/peft, not MLX — package-native.sh
steps 2–4 apply; step-1 MLX fuse replaced by peft merge) → verify → scale max_steps for the full run.

## T4 MEMORY MAP + WORKING KERNEL CONFIG (06-24, after 8 kernel iterations)
gemma-4-E4B (7.5B) QLoRA on a 16GB T4 (14.56GB usable) — **seq ceiling**: 8192 OOMs fwd · 6144 OOMs
bwd · 4608 OOMs bwd · **3584 FITS** (~14.3GB, ~300MB margin). Throughput **~42s/step** at 3584
(grad-ckpt doubles compute) → 200 steps ≈ 2.3h. So free Kaggle T4 ≈ the Mac's old 4608 budget, NOT
more. Working `kaggle/train/train.py` config:
- `machine_shape: NvidiaTeslaT4` (P100 default = CC6.0, won't run Unsloth) + CC≥7 guard.
- STOCK Kaggle torch (do NOT `pip install torch cu128` — drops sm_75/sm_60); pins transformers==5.5.0.
- `unsloth/gemma-4-E4B-it` 4bit; `r=8, lora_alpha=8, use_gradient_checkpointing="unsloth"`.
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` (set before `import torch`).
- glob dataset under `/kaggle/input/datasets/ignacytka/silver-nav-rich/`; in-kernel drop rows > MAXLEN.
- count tokens via `tok.tokenizer(...)` — `tok` is the multimodal Gemma4Processor, not a tokenizer.
- SFT fp16, ga4, max_steps 200, **`eval_strategy="no"`** (gemma-4 262K vocab → periodic eval
  materializes ~6.7GB logits → OOM even though training fits).
- save adapter + `TRAIN_OK` BEFORE the best-effort generation eval (so a gen quirk can't lose the run).
- **Loss 0.56→0.01 by ~step 300 = suspiciously fast → overfit risk** on the 4×-duplicated harness rows
  → consider dedupe / fewer steps / lower LR for the next run.
Data = `silver-nav-rich` v2 (medium: wide 13-tool surface + COMPACT descs + 1000 caps), kept 5950/8916
≤3584. Bugs fixed across v1–v8: dataset-not-finalized + mount path, OOM fwd, OOM bwd, processor
token-count crash, periodic-eval logit OOM.

## TODO: harness-EXACT training fidelity (user 06-24 — analyze AFTER first successful run)
Are we training on exactly the input sequences each supported harness (Claude Code, Codex, OpenCode,
Hermes) sends the model? **Closer now, not exact.** Behind ollama the model always sees the gemma4
wire format; per-harness variation we ALREADY replicate = tool NAMES + result JUNK + (rich) full tool
descriptions + gemma4 structure. **Remaining gap = the SYSTEM PROMPT**: renderers.ts renders the
generic `raw.policy`/ARGENT_SYSTEM_PROMPT, NOT each harness's real base prompt — which we HAVE RE'd at
`harness/{opencode,claude-code,codex,hermes}.md` (OpenCode ~32KB/~8K tok). Also tool-surface size (we
offer rich ~13–16; a raw harness may expose ~75).
**⚠️ TOOL-DESCRIPTION DISCLOSURE (user 06-24 correction — investigate):** harnesses usually HIDE/defer/
compact most tool descriptions until needed (proof: Claude Code's own deferred-tools + ToolSearch — full
schemas load on demand, not up-front). So the v1 "rich = full descriptions" assumption is likely WRONG
for real inference. Consequences: (1) train-VERBOSE / infer-COMPACT is the RISKY mismatch direction
(model leans on description text that isn't there at inference) — train-compact/infer-verbose is safe;
(2) facts like com.apple.Preferences then can't arrive via the description at inference → must come from
DEMONSTRATIONS (gym 296× Preferences) or pretraining — consistent with the temp-0 controlled test getting
it right; (3) disclosure likely DIFFERS per harness → the 4-harness rendering should vary tool-description
disclosure, not just names+junk. Action: capture each harness's ACTUAL tool block on the wire (logging
proxy) and match it; reconsider rich-mode verbose descriptions accordingly.

**✅ RESEARCH RESULT (06-24, code-cited — RESOLVES the disclosure question; OVERTURNS the "harnesses
compact" assumption):** investigated all 4 harnesses' ACTUAL wire behavior. **3 of 4 send FULL verbatim
descriptions — our compact ≤120-char (v5) matches NONE of them.**
- **OpenCode** (`sst/opencode` `mcp/catalog.ts::convertTool`): FULL verbatim descriptions + complete
  schemas, ALL tools at once, native function-calling. No truncation in code. → wants FULL.
- **Codex** (`openai/codex` `tools/src/mcp_tool.rs`): FULL verbatim descriptions, native (Responses API),
  default all-at-once. OPTIONAL deferred BM25 `tool_search` only if served model has
  `supports_search_tool`. Tool names namespaced **`mcp__<server>__<tool>`** (our codex renderer used
  plain `X` dash→`_` — WRONG, should be `mcp__argent__<tool>`). → wants FULL (+ optional deferred).
- **Claude Code**: DEFERRED — tool NAMES only up-front + a tool-search tool; full schema injected
  INLINE as a tool result ONLY after a search call (confirmed first-hand: this session's ToolSearch).
  ~3–5 non-deferred. → wants NAMES-ONLY deferred (we OVER-disclose).
- **Hermes**: FULL `<tools>` JSON schemas up-front in a ChatML system msg; `<tool_call>`/`<tool_response>`
  XML wire. → wants FULL.
**Implication:** correct data is PER-HARNESS: FULL descriptions for OpenCode/Codex-default/Hermes;
NAMES-ONLY deferred (+ a tool-search round-trip, schema injected as a later tool result) for Claude Code.
So v5's compact-for-all is a **T4-forced compromise, not fidelity** — and the earlier "rich verbose"
data (v1–v4) was actually CLOSER to reality for 3/4 harnesses.
**🚧 BLOCKER (logged, per "save progress + move on"):** FULL descriptions = ~5940 tok/row (exactly the
rich data that OOM'd the T4 at the 3584 ceiling). Full-fidelity per-harness training needs 16–32K seq →
**24GB+ GPU (rented RunPod/Modal ~$2/run) or TPU-bf16**. This is now the CONCRETE justification for the
bigger-GPU spend: not just for system prompts — to match the FULL tool descriptions 3/4 harnesses send.
TRACTABLE on the free T4 meanwhile: Claude Code deferred (names-only) rows are SHORT and fit; + the
codex `mcp__argent__` naming fix. Saved-and-parked: the full per-harness retrain awaits bigger compute.

**🔬 MULTI-GPU EXPLORATION (06-24, user asked "use Kaggle clustering"):** Kaggle free = **2× T4 (32GB
total)** — confirmed (`Num GPUs = 2`); our Unsloth runs used only ONE. NO Kaggle "Pro" exists (free;
the $10/$100 budgets are hosted-INFERENCE, not training). Explored using both:
- **Liger supports `gemma4_text`** (`apply_liger_kernel_to_gemma4_text`) → chunked CE removes the 262K-
  vocab **logits OOM** (the ~10GB single tensor that blocks long-seq gemma-4; it's why single-GPU
  Unsloth — which has chunked CE built-in — trained, while vanilla OOMs). trl 0.22.2 SFTConfig has NO
  liger flag → apply manually.
- **FSDP-QLoRA** (vanilla, no Unsloth): correct in theory but on Kaggle SCRIPT kernel both ranks loaded
  the full ~13GB fp16 model onto GPU0 → OOM (per-rank `device_map={"":rank}` needed; fiddly).
- **device_map**: `="auto"` fills GPU0 first (single-GPU); `max_memory` cap too small → CPU offload
  (bnb 4bit refuses); `="balanced"` went **lopsided** (whole model on GPU1: `GPU0 107MiB / GPU1 9173MiB`)
  → then the 10GB logits OOM'd. Needs a **hand-built device_map** over the **42** `Gemma4TextDecoderLayer`s
  + towers/embeddings, + manual Liger. Viable but ~1-2 more careful T4 runs (error-prone module mapping).
**Verdict:** free 2× T4 CAN do the full-fidelity ~6-8K retrain (Liger + custom map) but is fiddly;
**1× 24GB rented GPU (~$2 prepaid RunPod/Modal) is the clean path** — Unsloth's built-in chunked CE +
single card fits 6-8K trivially, no device_map gymnastics. DECISION (quota vs $2) is the user's.

**🔑 MULTI-GPU SOLVED — gemma-4 QLoRA TRAINS at 6144 across 2×T4 (06-24 night, "figure out the split").**
`kaggle/fsdp/fsdp_smoke.py` reached `MGPU SMOKE OK` (3/3 steps, ~25s/it). The working recipe is a STACK of
6 precisely-diagnosed fixes (each found by reading the full traceback, CUDA_LAUNCH_BLOCKING for the async ones):
 1. **Split** = hand-built device_map: 42 `Gemma4TextDecoderLayer`s split at layer S=28 (0–27→GPU0,
    28–41→GPU1); embeds+norm+PLE+lm_head→GPU1, vision/audio towers→GPU0. (v5 nvidia-smi GPU0 1709 / GPU1 7487MiB.)
 2. **fp32-upcast OOM** (the real 10.5GB killer, NOT the logits): trl `prepare_model_for_kbit_training`
    upcasts EVERY fp16 param→fp32 incl. the 2.6B PLE embeds. Fix: prep MANUALLY (freeze all, upcast only
    params <50M to fp32, keep big embeds fp16), `get_peft_model` ourselves.
 3. trl re-runs that upcast even with peft_config=None on an already-quant PeftModel → **neuter
    `trl.models.utils.prepare_model_for_kbit_training = lambda m,*a,**k: m`**.
 4. **LoRA target** must be a TEXT-only regex `.*language_model.*\.(q|k|v|o|gate|up|down)_proj$` — plain
    `["q_proj",…]` hits the vision tower's `Gemma4ClippableLinear` which vanilla peft can't wrap.
 5. **Logits** (262K vocab ~10GB): custom `compute_loss` runs the inner `m.model.language_model`
    (Gemma4TextModel — skips the multimodal merge that mixes cuda:0/cuda:1) for hidden states, then
    `LigerFusedLinearCrossEntropyLoss()(W, sh, sl)` where `W = base.embed_tokens.weight` (tied lm_head can be
    meta under a split map). `use_reentrant=False` (reentrant forks RNG across devices → illegal access).
 6. **`loss.to("cuda:0")`** — HF Trainer asserts loss on the primary device.
Single 16GB card (onegpu kernel) does NOT fit 6K → the split is genuinely needed; P100=16GB=one T4, no help.
**✅✅ SOLVED (06-24 night, ~21 runs): free STABLE 6K gemma-4 QLoRA on ONE T4 — no split, no H100s.**
Recipe = `kaggle/iso/iso.py` (silver-iso). The "persistent NaN" was 3 STACKED fp16 issues, pinpointed by
`torch.autograd.set_detect_anomaly(True)` on a single-GPU isolation:
 1. **Attention SOFTMAX backward → NaN in fp16** (`SoftmaxBackward0`). Fix: `attn_implementation="sdpa"`
    (fused softmax, fp32-internal, stable backward). Eager's manual fp16 softmax backward is the killer.
 2. **fp32/fp16 mixing → `ToCopyBackward0` NaN.** Fix: keep ALL params fp16 (NO fp32 upcast at all) — gemma
    RMSNorm already computes in fp32 internally, so fp16 norm params are safe.
 3. **The "grad_norm=nan every step" was the fp16 GradScaler OVERSHOOTING** init_scale=65536 → scaled grads
    overflow → skip every step → lr stuck 0. Fix: patch `torch.amp.GradScaler.__init__` to `init_scale=2**10`.
    Grads were FINITE all along (post-train check: 0 NaN params).
**MEMORY for 6144 on one 16GB T4:** offload the frozen 5.2GB PLE table `embed_tokens_per_layer` to CPU via
`device_map={"model.language_model.embed_tokens_per_layer":"cpu", "":0}` (+ `llm_int8_enable_fp32_cpu_offload=True`).
Only the gathered rows move to GPU each step (cheap). Attention stays single-GPU = stable.
**PROVEN (iso v7):** single T4, 6144 seq, chunked CE (Liger fused-linear-CE on `embed_tokens.weight`),
SDPA + all-fp16 + grad-ckpt(use_reentrant=False) + init_scale=2^10 → `hidden finite=True`, loss drops
13.06→0.93 in 8 steps, grad_norm finite, **peak 10.65GB (≈5GB headroom → 8K+ seq likely fits).**
**THE SPLIT (kaggle/fsdp) IS ABANDONED** — cross-device forward NaN with SDPA, softmax-backward NaN with
eager; single-GPU sidesteps both. Deployed silver-v5 (4608) still works; this unblocks a 6K+ retrain for free.
**REAL RETRAIN DONE (06-25): `silver-v6:e4b-text-Q6-K` trained + deployed via the free substrate.**
Kernel `kaggle/realtrain` on the verbose 16-tool data (silver-nav-verbose dataset, kept 6921/9272 rows
≤6144 — vs the deployed v5's 3584 which got far fewer), r=16, 150 steps ga4, loss 56→0.19. Packaged
locally (local_merge.py peft-merge → convert_hf_to_gguf → llama-quantize Q6_K → ollama; `package-v6.sh`).
**EVAL (curl vs ollama, temp 0): v6 is CORRECT in its real distribution but brittle out of it.**
 - Verbose tools (the format OpenCode/Codex/Hermes actually send): v6 emits `argent_launch-app{com.apple.Preferences}` ✅ (== v5).
 - Compact tools (lean verify; the desc strips the bundle-id example): v6 → wrong `com.apple.mobile.settings` / derails to text; v5 stays robust.
Root: v6 trained ONLY on verbose + only ~600/6921 rows seen (150 steps <1 epoch). **v6 is NOT a strict
improvement over v5 — keep v5 as the robust default.** NEXT for a deployable v6: (a) MIX lean+verbose data
(robust to both formats), (b) more steps (≥1 epoch), (c) maybe r=8 like v5. The substrate is the win; the
data-mix + step count are tuning. Throwaway eval scripts: /tmp/verify_v6.py, /tmp/verify_clean.py.
Gold standard = capture the LITERAL wire payload
from each harness via a logging proxy in front of ollama, train on those. **Blocker: free T4 = 8K
seq**; a real harness prompt (~8K) + conversation (~5K) overflows it → full fidelity needs 16–32K seq
→ TPU-bf16 (below) or paid 24GB+ GPU. Plan: (a) capture/diff per harness, (b) close gaps that fit 8K
now (e.g. truncated/representative prompts), (c) full version on the long-seq path. Edit point:
`harness/renderers.ts` render() system message.

## TODO (far future): use the TPU quota too (~2× free compute, and enables #1)
20 TPU-h/wk on top of 30 GPU-h/wk. Catch: **QLoRA/bitsandbytes is CUDA-only → won't run on TPU**;
needs a JAX/Flax (KerasNLP gemma) bf16 LoRA path. Upside beyond ~2× quota: TPU v5e-8 = 128GB HBM →
bf16 + long (16–32K) sequences with NO 4-bit memory pressure = the FREE route to the full
per-harness-system-prompt fidelity in the TODO above. Cost: a second training stack to build/maintain.

## Open decisions (resolve before the big retrain)
1. **Harness model:** lean controlled Argent harness (then current data + pruning works) vs raw
   third-party OpenCode (then must train on the fat distribution → bigger compute).
2. **Base model bake-off:** silver Gemma-3n-E4B vs Qwen3-4B vs dense Gemma-3-4B (vs E2B only if a
   low-RAM Mac forces it). Decide on the real navigation task, temp 0.
3. **Target Mac RAM** for deployment (24GB vs 64–128GB) — flips model-size/precision choices.
