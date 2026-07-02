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
- **Device fleet.** See "## Rollout fleet (researched)" below — immediate path is LOCAL/free; the scaled
  Android fleet has a hard host-privilege constraint. The *real* per-episode bottleneck is model inference
  (5-20 generates over 33k+ ctx), not boot; parallel rollouts need parallel inference (= GPU = $$), so the
  frugal path runs rollouts serially on the local Mac and only scales when RFT justifies paid infra.
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
0. **Harden the judge + measure the init** (do BEFORE any RL). (a) Validate judge agreement vs a few-hundred
   human labels — target <~3% error (DigiRL's evaluator bar) — because the judge BECOMES the reward and is the
   #1 failure mode. (b) Add programmatic/held-out success predicates (final route/deep-link, an AX/DOM
   assertion like "cart has item X", app-state check) and prefer them over the LLM judge where they exist.
   (c) Measure `ornith`'s sampling entropy + pass@k — if it's already low-entropy (RL-pretrained), exploration
   headroom is thin and you'll need higher rollout temp / a brief SFT refresh before RL bites.
1. `transcript_to_jsonl` exporter + a mask/round-trip test (testable NOW on existing bench transcripts). ← first code
2. `ARGENT_TEXT_ONLY` wired into the rollout argent (also unblocks a clean eval).
3. RL task pool (held-out, hundreds) + the programmatic success checks from step 0.
4. `rollout_multi` (K-sample bench variant) → RFT rounds on real/emulated devices.
5. Emulator fleet on vast.ai (scale rollouts).
6. Graduate to GRPO (vLLM + chosen framework) once RFT plateaus (entropy floor / all-fail tasks).

## Reward, judge & RFT specifics (research-backed: DigiRL, MobileRL, DAPO, ReST, RAFT)
Our setup maps almost exactly onto **DigiRL / MobileRL** (device-control RL bootstrapped from filtered
behavior-cloning / rejection sampling, then online RL with an autonomous evaluator). Concrete params:
- **RFT round (do this first):** K=4-8 rollouts/task at **temp ~1.0**; keep only judge-`success`; treat
  `partial` as fail initially; dedup + **cap successes-per-task (~2-4)** so easy tasks don't dominate; SFT
  `ornith` (reasoning ON, completion-only, observations masked); repeat 2-4 rounds. RAFT (train on positives
  only) is **competitive with GRPO/PPO** (arXiv 2504.11343) — most of GRPO's edge is just *dropping all-fail
  prompts*, a data-filter you can partly mimic in RFT. **Budget:** <10k total rollouts → spend it ALL on RFT.
- **Switch to GRPO when:** val success flat over 2-3 RFT rounds AND entropy near its floor, OR your hard tasks
  yield zero successes across K (RFT can't learn with no positive to imitate).
- **Reward:** terminal-dominant (+1 success / 0-−1 fail) + a **tiny** step penalty (~−0.05) + invalid-tool
  penalty (~−0.2). MobileRL "shortest-path adjustment" rewards efficiency without hackable dense shaping.
  Credit assignment via **learned value functions (DigiRL doubly-robust advantage)**, not per-step reward.
- **Judge hardening:** low temp (~0.1), structured/schema output, **conservative-zero on parse failure**,
  held-out validation set scored by the same judge to catch "reward up only on train prompts" (overoptimization
  signature). Early-stop on a **human/programmatic gold** check, not on judge score (Gao overoptimization laws).
- **GRPO (later):** K=8-16, temp 0.8-1.0, group-relative advantage, **KL-to-ref β~0.001** + PPO clip ~0.2,
  **DAPO clip-higher** (fights entropy collapse — our top GRPO risk), **dynamic sampling** (drop all-pass/all-fail
  groups), **token-level** loss aggregation, and a **success replay buffer** for all-fail batches.
- **Loss-mask the observations — and UNIT-TEST it.** Screenshot/AX observation tokens dwarf action tokens; a
  masking bug silently trains the model on environment text and poisons everything. (We already have this mask
  + `test_mask.py` for SFT; the RL trainer must reuse the exact same span logic.)

**Ranked failure modes to guard:** (1) judge reward-hacking / judge-is-the-ceiling → validate + programmatic
checks + gold early-stop; (2) loss-masking bug → unit test; (3) entropy collapse (esp. from an already-RL'd
ornith) → measure first, higher temp, clip-higher, KL leash; (4) all-fail hard tasks waste budget → dynamic
sampling + curriculum retirement; (5) proxy overoptimization → KL cap + held-out gold monitor.

## Rollout fleet (researched: DigiRL/MobileGym precedents + vast.ai/redroid constraints)
- **Immediate (frugal RFT): rollouts run LOCALLY on the Mac** — reuse the existing silver-bench iOS-sim path
  (free, already works), 1 ollama policy + a few sims, serial episodes. No cloud cost. This is the RFT rung.
- **Scaled fleet (GRPO, later) has a HARD host-privilege constraint — the biggest blocker, and it's not GPU:**
  - **Stock vast.ai / RunPod pods CANNOT host it.** They're unprivileged containers; vast's Docker-Options
    field ignores `--device` / `--privileged` / `--cap-add`, so `/dev/kvm` (AVD emulator) can't be passed in
    and redroid's `--privileged` + host `binder`/`ashmem` can't be granted. Treat marketplace GPU **pods** as
    non-qualifying by default (~0% have usable KVM).
  - **Rent kernels, not pods:** vast.ai **VM instances** (`vms_enabled=true`, `docker.io/vastai/kvm` images →
    root + real kernel) or **whole-machine/bare-metal**. **Gate each box** on `ls -l /dev/binder` (redroid) or
    `/dev/kvm` (AVD) BEFORE admitting it to the fleet.
  - **Substrate = redroid** (containerized Android, shared host kernel, NO KVM): **~15-25/box @ 0.5-2 GB each**
    (3-5× denser than AVD's 10-30 @ 4-6 GB *with* KVM), boots in seconds, sideload APKs (Bluesky
    `xyz.blueskyweb.app`, Mastodon `org.joinmastodon.android` run GMS-free). **Prefer ARM64 hosts** (skip x86
    ARM-translation). Use the AVD emulator only where nested `/dev/kvm` is confirmed.
  - **Attach:** `adb connect 127.0.0.1:<5555+i>` (serial = `host:port`) → one Argent tool-server per instance
    via `ANDROID_SERIAL`, one shared adb server (5037), unique forward ports (adb forward table is global).
    Maps cleanly onto the existing device-allocator (one instance = one serial → one tool-server).
  - **Fast episode reset:** golden `/data` volume swap, or `am force-stop <pkg>` + deep-link relaunch
    (sub-second, keeps login); AVD live snapshot `emu avd snapshot load golden` (~1-2s) where KVM exists.
  - **Precedents:** DigiRL (≤64 AVDs), MobileGym/MobileRL (100s-1000s Dockerized AVDs = batch size), Google
    Cuttlefish (~40 per 128-core box, needs KVM+privileged). Managed farms (Genymotion ~$0.6/dev-hr, AWS Device
    Farm) are 1-2 orders too expensive for RL rollouts — keep for occasional real-device eval only.

## Open questions (research in flight / to resume — agents hit session limits)
- **Framework for the GRPO rung** (external-env async rollouts + LoRA + 65k ctx): TRL GRPOTrainer vs veRL vs
  `verifiers` vs prime-rl — NOT yet resolved (agent capped). Bias: whichever cleanly supports a custom
  external-device rollout loop (most assume a pure-function env).
- **vLLM support for gemma3n hybrid attention** — if absent (likely), the GRPO rung must use ornith / a
  standard-arch base for serving. NOT yet resolved (agent shallow). RFT doesn't need vLLM, so this is deferrable.
