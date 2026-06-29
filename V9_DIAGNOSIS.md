# Why silver (fine-tune) loses to base gemma — diagnosis + v9 rework

**Benchmarked fact (silver-bench v2, native logged-in Bluesky, OpenCode harness):**
`gemma:argent 30%` vs `silver-v8:argent 20%`; `silver-v8:agent-device 5%`. The QLoRA fine-tune is
WORSE than the base it started from. v5→v8 never beat the base. This is a fundamental-paradigm failure,
not a knob-tuning gap. (haiku/gpt/gemma-agent-device cells still completing — for full data.)

Diagnosed by a 6-agent swarm (06-29 night). Root causes, all evidence-backed:

## 1. CRITICAL — Train↔inference FORMAT mismatch (byte-verified; likely the dominant cause)
The datagen **re-implements argent's tool-result format by hand** in `harness/renderers.ts` and gets it
wrong on every observation. The model trained on a wire format it never sees at inference → OOD on EVERY
read → mis-parses its own action outcomes and loops on `describe` (its exact observed failure). The base
has no such bias, so it wins.
- Action result: TRAIN = `""` + a separate user msg "Cannot read image"; INFER = `{"tapped":true,"timestampMs":N}` + `\n\n--- Screen after action ---\nSaved: …png`. Action-confirm JSON in **0** training rows; "Cannot read image" in **0** inference results.
- `describe`: TRAIN = raw text; INFER = `{"description":<text>,"source":"ax-service"}` (pretty-printed) + a **3-line coordinate preamble** that training STRIPS.
- All JSON results: TRAIN compact 1-line; INFER `JSON.stringify(…,null,2)`.
- Truth source = `argent/packages/argent-mcp/src/content.ts` + `tool-server/.../format-tree.ts` + `.../gesture-tap/index.ts`. **Fix: render rows through the real argent stack (or import content.ts/format-tree.ts), not renderers.ts.** Independently verifiable (diff a generated row vs a live `argent describe`).

## 2. CRITICAL — Reasoning is fully ablated; data is idealized scripts with no recovery
- **0 / 9917 tool-call turns carry any reasoning** (`prepare-v8.ts` renders `narration:false` → `content:""`). Completion-only masking then trains "emit a tool call, think nothing." That suppresses the adaptive screen-reasoning the base wins with. The gym DOES generate good thoughts ("Reading the AX tree so I don't guess coords", "target not visible — scrolling") — they're just dropped.
- **62% synthetic gym** = 4 fake apps / 22 screens; gym describe trees are 3× smaller & 4.7× cleaner than real (gym median 5 elems / 15% duplicate labels vs real 16 / 71%), and the gym **leaks the target in the prompt** → memorize-a-clean-world, OOD on real apps.
- **Every trajectory is a straight-line success** (99.86% confident-success finals, ~29 errors in 1515 rows, no dead-ends). The model never sees a failed tap → learns barrel-through + confabulate, can't re-evaluate.
- My v8 `stripStart` introduced **contradictions**: 92 rows ignore setup the prompt demands; 36 finals confabulate "Booted…" with no boot call. Teaches instruction-ignoring + outcome-confabulation. (Real bug.)

## 3. STRATEGIC — Wrong paradigm: SFT-of-scripts memorizes; RL generalizes
GUI-agent literature is overwhelming and on-point ("SFT Memorizes, RL Generalizes", ICML'25):
- **DigiRL (device control): SFT 17.7% → RL 67.2% (+49.5pp)** — the failure RL removes is "can't recover / escape OOD states" = silver's exact problem. WebRL (8B: 4.8%→42.4%, 2.4× GPT-4-Turbo), ETO (DPO on fail→success, biggest gains OOD), Agent Q (18.6%→81.7%→95.4%), VEM, UI-TARS, OS-Genesis all confirm: train on the model's OWN rollouts with a reward, not on scripts.

## 4. HARD CONSTRAINT — data-scale floor
GUI grounding is learned at **10⁶–10⁸** examples (UGround 10M, OS-Atlas 13M); real trajectory sets are
10⁴–10⁵ episodes; **ours is ~10³ (1515 rows) — 3-5 orders of magnitude below the grounding floor.** A set
this small can only do LIGHT task-adaptation of an already-grounded base; it CANNOT teach grounding/perception
(it just overfits). Don't try. LoRA itself is fine (it forgets *less* than full FT; target all-linear is
correct; our r=8 is on the low side per Biderman α=2r).

## v9 PLAN (ranked)
**Cheap, testable now (recipe/data within SFT — expected to narrow, not clear, the gap given the scale floor):**
1. **Fix the format mismatch (#1)** — render results through the real argent stack so train == serve byte-for-byte. Highest-leverage, cheap, verifiable.
2. **Reasoning-in-loss (#2)** — keep `step.thought` (built: `prepare-v8.ts --narration`, verified 63% of turns carry reasoning, lands in the labeled span). *Test running now (silver-v9rsn, r=8, the only change vs v8).*
3. De-idealize data: ≥60% real, perturb gym trees, stop leaking target, add failure/recovery + honest finals, fix `stripStart` to regenerate prompt+final to match the stripped trajectory.

**Fundamental (the real fix — beats the base):**
4. **Scaffold the strong base (F-Option-A, $0):** constrained decoding (grammar so tool calls can't be malformed + bundleId/tool from the offered set), a deterministic state-tracker (kills the re-boot reflex), observation compaction (41KB describe → compact indexed element list, model taps an index). Removes ~60% mechanical failures with zero training. Also raises the base's success rate = cheap positives for #5.
5. **RL / learn from own verified successes (F-Option-B):** rejection-sampling SFT → DPO on (success,failure) pairs → GRPO. Reward = the silver-bench VLM judge (have it) + the gym grounding validator (have it). On-policy → no train/serve gap, no script to memorize, learns to recover. The only path that can EXCEED the base.
6. Bootstrap #5 with a frontier teacher (haiku/gpt, already wired) driving the REAL harness on REAL apps (distillation / DAgger seed).
- Architecture note: field winners are **planner-big / grounder-small splits**; reference = Apple **Ferret-UI Lite** (3B on-device: real+synthetic mix + SFT + CoT + tool-use + RL). Set-of-marks is WORSE than a11y-text for grounding (SeeAct 39.1 vs 20.3) — don't pivot to SoM.

**Bottom line:** stop iterating the SFT-of-synthetic-scripts paradigm. v9 = (a) make training byte-match real
inference + restore reasoning [cheap, narrows gap], then (b) scaffold the base + RL on its own real rollouts
[the actual fix]. Treat v8 as the last data-knob iteration; the leverage is in #1, #4, #5.

## UPDATE — catastrophic-forgetting probe (06-29 night, $0 local): REFUTED as the primary cause
silver-v8 vs gemma on general tasks (no tools, temp 0): reasoning (150=150), knowledge (Canberra=Canberra),
writing (both clean rhyming couplets) all on par; only a minor instruct-following nuance (silver wrapped
JSON in ```fences). So the fine-tune did NOT broadly erase general capability — the degradation is
**NAV-SPECIFIC**. This DOWNWEIGHTS the "mix in general data / anti-forgetting" lever and UPWEIGHTS the
nav-specific causes: the train/inference FORMAT mismatch (#1) and the bad/idealized/reasoning-free nav data
(#2). v9 priority order: fix the format mismatch + de-idealize nav data + reasoning-in-loss, then RL on real
rollouts. (General-data mixing is now a minor nicety, not a core fix.)
