# RL training env for silver v11 (device-nav) — architecture & build plan

Status: DESIGN. Some choices marked `[research]` are being confirmed by parallel research (framework,
vLLM/gemma3n support, KVM-on-vast.ai, reward design). See `FINETUNE_RECIPE.md` for the SFT lessons this
builds on and `VAST_AI.md` for the compute layer.

## Why RL (and why now)
v5→v10 was SFT / behavior-cloning of fixed trajectories — imitation, with a narrow sweet spot and no way to
reward *persistence until success*. Our own v9 post-mortem said the next move is "RL on our own rollouts."
An RL-pretrained init (`ornith`, already shaped for similar tasks) makes this a continuation, not a cold
start. RL also structurally kills the train≠serve bug (the model learns from ITS OWN rollouts in the real
serve context) and optimizes the thing we measure (task success), not a next-token proxy.

## The ladder (build in this order — each rung reuses the last)
1. **RFT / rejection-sampling (ReST/STaR)** — cheapest, reuses everything we have. Roll the current policy
   out K times per task, keep only judge-SUCCESS trajectories, SFT on them, repeat. No policy-gradient
   engine, no vLLM. Validates the rollout+reward loop and often gets most of the early gain. **START HERE.**
2. **GRPO / RLVR** — true on-policy RL. Group-sample K rollouts/task, reward = judge verdict, group-relative
   advantage (no value net), KL-to-ref to avoid collapse. Needs vLLM rollouts + logprobs. Bigger lift.
3. **Dense-reward / curriculum** — only if sparse terminal reward plateaus.

## Components
```
                 ┌────────────── rollout harness (per episode) ──────────────┐
   policy (LoRA)  │  reset env → [ observe(describe) → act(tool) ]* → done     │  → trajectory
   served by ─────┤          ▲ tool-server drives the device                   │  + reward
   vLLM/ollama    │          └────────── Android emulator (app) ───────────────┘
                 └───────────────────────────────────────────────────────────┘
        trajectories + rewards ──► trainer (RFT: SFT on successes | GRPO: policy grad) ──► new LoRA ──► loop
```
- **Policy serving.** RFT: reuse **ollama** (no logprobs needed, we only keep the text trajectory). GRPO:
  **vLLM** with LoRA + logprobs `[research: vLLM gemma3n hybrid-attn support is a real risk — may force the
  ornith/standard-arch base for the GRPO rung]`.
- **Rollout harness.** This is ~90% our existing `silver-bench` (`runner/bench.py`): it already resets the
  app, drives the model↔tool-server↔device loop, and captures the transcript. For RL we (a) run each task K
  times at temperature>0, (b) score with the existing judge, (c) export trajectories. Keep it separate from
  the eval bench so we never train on eval tasks.
- **Reward.** The existing LLM judge (success/partial/fail → 1/0.3/0). `[research: guard against judge
  reward-hacking — add a programmatic/held-out success check where possible; judge-as-sole-reward is risky]`.
- **Device fleet.** Rollout throughput is THE bottleneck (each episode is minutes). Need many parallel
  **Android emulators** (Linux-native, scriptable, resettable) — iOS sims are mac-only and won't scale on
  vast.ai. `[research: does vast.ai expose /dev/kvm? if not → redroid/containerized Android, or a separate
  device-farm host]`. Argent already drives Android via adb/uiautomator; give each emulator a distinct serial.
- **Trainer.** RFT: our `h100_train.py` (unchanged — SFT on the exported successes). GRPO: `[research:
  TRL GRPOTrainer vs veRL vs verifiers vs prime-rl — need async external-env rollouts + LoRA + long ctx]`.

## The RFT loop (rung 1 — concrete, buildable now)
```
seed policy = ornith (or silver-v10) ; dataset D = data-v10 (optional warm mix)
repeat:
  for task in TRAIN_TASKS:                     # a HELD-OUT-from-eval task set
     for k in 1..K (temp ~0.7):                # K diverse rollouts
        traj, transcript = rollout(policy, task, emulator)   # = silver-bench episode
        if judge(traj) == success: D += export_to_training_jsonl(transcript)   # our {messages,tools} format
  dedupe/balance D
  policy = SFT(h100_train.py, D)               # BASE=<seed base>, reasoning ON, completion-only
  benchmark(policy) vs base                    # stop when it stops improving -> graduate to GRPO
```
New code needed for rung 1 (small):
1. **`rollout_multi`** — run silver-bench with K samples/task at temp>0 into an RL-results dir (NOT the eval
   results). Mostly a bench flag + a separate task file.
2. **`transcript_to_jsonl`** — convert an opencode rollout transcript → our exact `{messages, tools}` training
   row (the model's own reasoning+tool_calls+observations). This is the crux: it makes training data that is
   BYTE-IDENTICAL to serve (the ultimate train==serve). Must handle the screenshot attachment consistently
   (drop image / keep text — same decision as `ARGENT_TEXT_ONLY`), and preserve the reasoning-before-tool_call
   ordering the mask expects.
3. **success filter** — read `score.json`, keep verdict==success (later: also partial with lower weight).

## Prereqs / cross-cutting
- **Fix the image path first.** The screenshot base64 attachment makes the text-only model refuse (~40% of
  tasks in the eval). For RL this corrupts BOTH the reward (spurious failures) AND the training data. `ARGENT_TEXT_ONLY`
  (drop the PNG, keep `Saved: <path>`) must be on for every rollout. Non-negotiable before rollouts.
- **Train tasks ≠ eval tasks.** Generate/curate a separate pool of device-nav tasks for RL (hundreds), with
  programmatic success checks where possible, disjoint from the eval benchmark.
- **Throughput math.** ~1 episode ≈ 3-8 min. RFT wants ~K·|tasks| rollouts/round (e.g. 8·200 = 1600 ≈ many
  GPU·emulator-hours). Fleet size sets wall-clock; this is why vast.ai (many cheap Linux boxes) + Android
  emulators matters.

## Build order
1. `transcript_to_jsonl` exporter + a mask/round-trip test (testable NOW on existing bench transcripts). ← first
2. `ARGENT_TEXT_ONLY` wired into the rollout argent (also unblocks a clean eval).
3. RL task pool (held-out) + programmatic success checks.
4. `rollout_multi` (K-sample bench variant) → RFT round on real/emulated devices.
5. Emulator fleet on vast.ai (scale rollouts).
6. Graduate to GRPO (vLLM + chosen framework) once RFT plateaus.

## Open questions (research in flight)
- Framework for the GRPO rung (external-env async rollouts + LoRA + 65k ctx)?
- vLLM support for gemma3n hybrid attention — or must GRPO use ornith/standard arch only?
- /dev/kvm on vast.ai — real emulators, or containerized Android (redroid)?
- Judge-as-reward hardening (programmatic checks, held-out verification) to prevent reward-hacking?
