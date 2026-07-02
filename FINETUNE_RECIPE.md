# Fine-tuning models for Argent — working recipe (distilled through silver v5→v10)

Empirical basis: a small-n (10–20 task) real-native-app nav benchmark. Base `gemma-4-e4b` scores
~33–40% zero-shot. Silver spent v5–v9 *at or below* that. **v10 is the first to beat it: 62–67% vs
~33% base**, by fixing the dataset — not depth, quant, or infra. Treat the numbers as directional
(small n), the causal lessons as solid.

---

## TL;DR
QLoRA a base that already does *some* device-nav zero-shot, on real Argent trajectories rendered
**byte-identically to what the model sees at inference** (full OpenCode system prompt + 59-tool
catalog + reasoning + tool calls), with a **completion-only loss mask** so gradient lands only on the
assistant's reasoning + tool_calls (~1% of each ~47k-token row). **Keep reasoning in the render.**
Train ~300 steps. Merge → GGUF → ollama. Measure on **real apps**, and require it to **beat the base**,
not just emit valid tool calls.

## The five things that actually moved the needle (ranked)
1. **train == serve, byte-for-byte.** The #1 silent killer (v9). The training row must be the exact
   byte string the model receives at serve time: same OpenCode system prompt, same tool-catalog text,
   same chat template, same tool-call/tool-response markers, same image handling. Any drift (a stripped
   token, reordered block, different quoting) and the model is being tested out-of-distribution. v9's
   "format fix" alone was worth ~nothing until combined with #2, but getting it *wrong* caps you below base.
2. **Reasoning preserved in the render.** Raw trajectories always had thinking (~93%). v9's render
   **stripped it** → training text was `screen → tool_call → screen → tool_call`, teaching pattern-match,
   not think-then-act. v10 re-renders with reasoning ON (~63% of rows carry a thought before the call).
   This single change is what crossed base. Put the thought **before** the tool_call (`REORDER_THOUGHT`).
3. **Completion-only loss mask.** ~99% of each row is static harness (system prompt + tool catalog +
   environment tool_responses). Mask all of it. Label ONLY assistant-generated spans: the
   `<|tool_call>…<tool_call|>` blocks, the final summary, the closing `<turn|>`. EXCLUDE
   `<|tool_response>…<tool_response|>` (environment output). p50 labeled ≈ 1%. Full-sequence loss spends
   the gradient reconstructing the harness and learns nothing useful.
4. **Real target-app coverage + diversity.** v7/v9 had 79% of train = 39 memorizable synthetic screens
   and **Bluesky 0×** — while the benchmark *is* Bluesky. Result: trajectory-prefix overfitting (v7 rebooted
   the device 8/20 tasks). Cover the apps you'll be judged on, with many distinct screens, varied start
   states, and deduped rows. A general instruction-data mix helps against narrow overfit.
5. **Beat the base, don't just call tools.** A model that emits 100% valid tool calls can still score 0%
   real nav (our proxy scorer read 66.7% "grounding" on a model that navigated 0%). The base is a strong
   floor. If you're not clearly above it on *real device nav*, you've regressed.

## Non-negotiable precondition: the base must already be capable
Fine-tuning **narrows and sharpens**, it doesn't create the skill. `gemma-4-e4b` base already navigates
~35% zero-shot; that headroom is what v10 exploited. **Before spending a cent training a new base
(ornith), 0-shot benchmark the raw base.** If it's ~0% at device nav, LoRA won't save it. If it's already
great, you know your ceiling. This 20-minute test gates the whole experiment.

## Data recipe (what the `.jsonl` must contain)
| Requirement | Why | v-history |
|---|---|---|
| Reasoning rendered before each tool_call | think-then-act, not pattern-match | v9 stripped → v10 ON (63%) |
| Byte-identical to serve context | no OOD at inference | v9 mismatch capped below base |
| Completion-only mask (assistant spans only) | gradient not wasted on 99% harness | stable since v6 |
| Target apps present (Bluesky, etc.) | benchmark tests them | v9 had 0×, big miss |
| Many distinct screens, deduped | anti-memorization | v7 18.4% unique/92× → overfit |
| Varied start states | no trajectory-prefix overfit | v7 rebooted 8/20 → v8 fix |
| Token-length spread (~30–78k) | matches real long serve rows | v7 narrow 30–39k → v8 widened |
| Consistent image handling | model must ignore/handle the PNG in every tool result | see infra note |

Sizes for reference: v10 = 1438 train / 200 valid; median row ~47k tokens (the OpenCode system prompt is
~33k of that). This is why MAXLEN must be large (below).

## Training config (QLoRA kernel — `datagen/h100_train.py`)
| Param | Value | Note |
|---|---|---|
| base load | 4-bit nf4 (bitsandbytes), bf16 compute | QLoRA |
| LoRA targets | `.*language_model.*\.(q|k|v|o|gate|up|down)_proj$`, r=16, α=16 | **gemma3n-specific regex — must change per base** |
| vision/audio towers | NOT trained | text-LM only |
| loss | completion-only (custom mask), Liger fused-linear-CE on inner text model | Liger avoids the 262k-vocab logit OOM |
| batch | per-device 1 × grad-accum 4 | effective 4 |
| LR | 2e-4, cosine, warmup_ratio 0.03 | |
| MAXLEN | **65536** | default 40960 drops 79% of v10's long rows; rows > MAXLEN are dropped, not truncated (truncation would cut the labeled answer off the end) |
| steps | ~300 (≈0.87 epoch; 1 epoch ≈ 344) | 300 beat base; save_steps=50 |
| grad-ckpt | OFF on 80GB (fits); ON for smaller GPUs | `use_reentrant=False` |
| optim | adamw_8bit, bf16, no GradScaler | bf16 has fp32's exponent range |
| resume | `MAX_STEPS` env rebuilds the cosine schedule + restores `last_epoch` from `./out/checkpoint-N` | extend a run cleanly |

## Render / format (train == serve)
- Emit the **exact** OpenCode chat template + tool markers the serving stack produces.
- Reasoning block **before** the `<|tool_call>` (`REORDER_THOUGHT=1`).
- Represent tool results the same way the server does. Argent's MCP auto-attaches a base64 PNG to *every*
  tool result. Two consistent options — pick one and use it in BOTH train and serve:
  (a) keep an image placeholder in the row, or (b) `ARGENT_TEXT_ONLY=1` drops the PNG, leaving
  `Saved: <path>` text. Vision-stripped GGUFs choke on the raw base64; the ollama path happened to
  tolerate it, but consistency is the rule, not luck.

## Packaging (adapter → deployable)
peft-merge fp16 (keep multimodal) → `convert_hf_to_gguf.py` (auto-extracts the text LM) → `Q6_K` →
`ollama create`. Modelfile: `TEMPLATE {{ .Prompt }}`, `RENDERER gemma4`, `PARSER gemma4`,
`PARAMETER num_ctx 131072`, `PARAMETER temperature 0`. (Q6_K of the E4B text-LM = 6.17GB, deterministic.)
Low-disk order: after convert, delete the merged fp16 *before* quantize; delete f16 GGUF *before*
`ollama create` — peak is otherwise merged(16G)+f16(15G) then f16+Q6_K+ollama-copy.

## Benchmarking honestly
- **Real native apps, not browser builds.** Keep a per-task screenshot for proof.
- Proxy/tool-choice scorers over-read; they're a cheap smoke test, not truth. The truth is real nav % on device.
- Always run the **base** in the same harness as the control. Beating base is the bar.
- Parallel streams: allocate a separate sim per run (device-allocator), share the device-agnostic
  tool-server, isolate with `bench.py --udid`. ollama holds ~2 models; API models don't contend.

## Infra & economics (hard-won)
- **GPU:** A100 PCIe 80GB is the most $/iteration-efficient (training is bandwidth-bound). ~140s/step at
  MAXLEN 65536; 300 steps ≈ 11h ≈ ~$14. H200 was a costly detour.
- **Deps (gemma3n kernel):** torch **2.6.0+cu124** pinned to the flash_attn 2.7.4 (torch2.6) + xformers
  0.0.29.post3 wheels. Do NOT `pip install unsloth` (drags torch→2.10, breaks flash_attn.so). Remove
  `torchao` (breaks under 2.6, masquerades as a Bloom import error). peft 0.19.1 + transformers 5.5.0.
- **Storage:** a RunPod pod with `volumeInGb: 0` WIPES its container disk on stop. Push every checkpoint
  to HF **and verify the bytes** before stopping. (We lost the v10 ckpt-300 raw adapter exactly this way;
  the merged GGUF survived because it was in 3 places.)

## Swapping the base model — checklist for `ornith:9b-q4_K_M`
`q4_K_M` is a **serving** GGUF quant. **Training needs the fp16/bf16 HF safetensors of ornith**, not the
GGUF — QLoRA re-quantizes to 4-bit nf4 at load. Steps and what changes:
1. **0-shot benchmark raw ornith first** (see precondition). Gate the whole run on this.
2. **Architecture-dependent swaps:**
   - LoRA `target_modules` regex → match ornith's module names (it has no `language_model.` submodule
     unless it's also multimodal; likely just `.*\.(q|k|v|o|gate|up|down)_proj$`). Verify with
     `print(model)` and only target attention+MLP proj.
   - Attention kernel: gemma3n needs the hybrid flash+xformers hack *only* because 7 layers have head_dim
     512 (flash rejects >256). A standard 9B dense model → drop the hack, use plain flash_attn or sdpa. Simpler.
   - No vision tower on a text-only 9B → drop the multimodal-keep merge logic; the Liger inner-text-LM CE
     may be unnecessary unless the vocab is huge.
3. **Render for ornith's template.** train==serve still rules: emit ornith's chat template + OpenCode
   system prompt + tool markers exactly as *its* OpenCode provider serves them. Rebuild the completion-only
   mask against ornith's tokenizer (the assistant-span markers differ per template).
4. **Package:** merge → GGUF → ollama with ornith's `RENDERER`/`PARSER` (NOT `gemma4`) and its `num_ctx`.
5. **Cost note:** 9B dense ≈ 2× the compute/memory of E4B (effective ~4B) per step and at serve — slower,
   heavier KV at 131k ctx. Budget accordingly.
6. **Keep everything else identical** (reasoning ON, completion-only, MAXLEN sized to the app rows,
   ~300 steps, real-app data, beat-the-base bar) so the comparison isolates the base.

## Results log
| ver | change | real-nav vs base |
|---|---|---|
| v7 | synthetic, narrow, prefix-overfit | 20% vs ~40% (rebooted 8/20) |
| v8 | varied start states, wider token spread | ~ties |
| v9 | full data, but format mismatch + reasoning **stripped at render** | LOSES (~20–35% vs ~30) |
| v9fmt/rsn/rsn2 | byte format fix + reasoning-surface attempts on stripped data | flat |
| **v10** | **reasoning ON at render + byte-preserved format, completion-only, 300 steps** | **62–67% vs ~33% — first to beat base** |
