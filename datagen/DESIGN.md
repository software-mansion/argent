# Design: synthetic training data for an Argent-native model

## Goal

Fine-tune a model that drives the Argent toolkit well: given a task ("test the
login flow", "profile re-renders on the home screen", "find the source of this
button"), produce the correct sequence of Argent tool calls, interpret the
results, follow the workflow discipline (discovery-before-tap, device selection,
`run-sequence` batching, profiling/flow procedures), and recover from failures.

The **primary deliverable is the data**, not the trained model. A tiny model
(~4B) trained for ~$500 will prove the data works; the $50k run follows. So the
bar for the data is: **super-high-quality and huge-volume**.

## Why the obvious approach fails

The default move — prompt a strong LLM to write tool-use conversations — fails on
exactly the axes that matter for an Argent-native model:

- **Hallucinated tool surface.** The model invents tool names, parameters, and
  enum values that don't exist. (Even the shipped skill docs mention a `paste`
  tool that isn't in the registry — anything trained on those docs would emit an
  invalid call.)
- **Ungrounded coordinates.** Argent's cardinal rule is *never guess tap
  coordinates; read them from a discovery tool*. An LLM writing a conversation has
  no real screen, so its tap coordinates are fiction — and a model trained on
  fiction learns to guess, the exact behavior the toolkit forbids.
- **Inconsistent observations.** `describe` output, component-trees, and profiler
  reports have precise formats. An LLM approximates them, and the inconsistency
  teaches the model to expect noise instead of structure.

You can pay an LLM to grade and filter, but you're filtering a low-quality
distribution and paying per token to do it. At "huge volume" that's both
expensive and leaky.

## The approach: a deterministic Argent gym + an expert policy + hard gates

Treat trajectory generation as **rollouts in a simulator**, not text generation.

1. **Ground truth from the real toolkit.** Extract all 67 tool schemas from the
   live Argent registry (`spec/tools.json`). Port the real output serializers
   (`describe`, `debugger-component-tree`, `view-network-logs`, profiler reports)
   so observations are byte-compatible with production.

2. **A gym (`gym.ts` + `archetypes/`).** A text-simulator whose state is
   devices + launched apps + the current screen (an element tree with normalized
   frames) + profiler/flow/network state. Each tool has a transition function that
   mutates the state and returns the exact observation the real tool would. Apps
   are screen graphs with navigation edges, so multi-step navigation is a real,
   walkable path.

3. **An expert policy (`expert.ts`).** The `argent.md` rules encoded as code:
   list-devices first, boot only if nothing's ready, one discovery per screen, tap
   the *centre of a discovered element*, re-discover after the screen changes, use
   component-tree for RN (after connecting the debugger) and describe otherwise,
   batch with `run-sequence` when no observation is needed between steps, follow
   the profiling/flow/network procedures, and recover from injected failures (tap
   miss, describe error, boot timeout, debugger drop) the way the skills prescribe.

4. **Hard gates (`validate.ts`).** Schema (strict), structure, device-order,
   policy, and — the differentiator — **coordinate grounding**: every tap must
   resolve to an element in the most recent discovery output. Nothing ships
   without passing all gates; `selfcheck.ts` proves the gates reject the nine
   canonical corruptions.

5. **A thin natural-language layer (`narrate.ts`).** Varies *how* the user asks
   and *how* the assistant narrates — never the grounded action/observation
   backbone. This is the only place an LLM should later be applied (paraphrase +
   re-validate), keeping linguistic diversity orthogonal to correctness.

### Why this yields both quality and volume

- **Quality is structural, not statistical.** Observations come from the
  simulator (never hallucinated). Tap coordinates are element centres (always
  grounded). Tool calls validate against the real schemas (always well-formed).
  Workflow order is the expert's by construction (always policy-compliant). The
  grounding gate makes "non-hallucinated" a *checkable property*, not a hope.
- **Volume is free.** No LLM call is on the critical path, so the marginal cost of
  a trajectory is a few microseconds. ~1,300 validated trajectories/sec on one
  core; linear in cores after that.
- **Failure is a feature.** Injected failures + scripted recovery teach robustness
  — the single hardest thing to get from naive generation, which rarely depicts
  the *correct* response to a tool error.

## Current state (this PR)

- 67-tool catalog extracted and used as the validation ground truth.
- 4 app archetypes (native iOS Settings, RN e-commerce, RN auth, Chromium
  dashboard) across iOS / Android / Chromium.
- 16 task families: navigate-tap, toggle, login, scroll-find, run-sequence,
  visual-regression, profile (+ drill-down), flow record/replay, network-inspect,
  android-setup (cold boot), debug-inspect, deep-link, console-check, pinch-zoom,
  chromium-tabs, native-inspect.
- **40/67 tools (60%) exercised**; ~9 tool calls/trajectory; ~10% include a
  recovery sub-trajectory; balanced platform mix.
- Pilot: **800 train + 100 eval, 0 rejected**, fully deterministic, with OpenAI
  and ShareGPT exports. Validator self-check: 9/9.

## Path to the proof model (~$500)

1. Generate ~30–50k trajectories (`--n 40000`; minutes). Hold out the eval split
   (disjoint seeds) plus a *harder* held-out set built from **archetypes the
   training set never saw** (author 2–3 eval-only apps) to measure generalization,
   not memorization.
2. SFT a ~4B base (Qwen2.5-3B/7B-Instruct or Llama-3.2-3B) on `train.openai.jsonl`
   (axolotl/LLaMA-Factory consume ShareGPT directly). Tool-call loss masking on
   the assistant turns; keep the system policy + tools in context.
3. Evaluate against the gym itself as an environment: replay the model's calls
   through `gym.execute`, score with the same validators (schema-valid %,
   grounded-tap %, policy-violation rate, task-success %). This is a *programmatic,
   reproducible* eval — no human grading, no LLM judge needed for the core metrics.
4. Success criterion for the proof: the 4B clears, say, >95% schema-valid,
   >98% grounded taps, and beats the base model's task-success on the held-out
   archetypes by a wide margin. If it does, the data works and the $50k run is
   de-risked.

## Scaling to the $50k run

- **Breadth before depth.** The highest-leverage work is more archetypes and task
  families (close the remaining 27 tools; add adversarial/edge-case worlds: locked
  screens, permission modals, empty states, network failures, offscreen targets,
  multi-app handoffs). Each is mechanical (see README "Extending").
- **Parallelism.** Generation is embarrassingly parallel — shard by seed range
  across cores/machines. Authoring archetypes and task families fans out cleanly
  to multiple agents (one file each, low conflict). For a large authored expansion,
  an orchestrated multi-agent run (e.g. Claude Code's Workflow / "ultracode") can
  draft N archetypes + critique them in parallel, then this pipeline turns them
  into validated data deterministically.
- **LLM augmentation, bounded.** Spend tokens only to paraphrase the NL layer and
  to add a *small* fraction of genuinely hard reasoning narration, always followed
  by re-validation. Optionally add a held-out LLM-judge pass on a sample for
  naturalness — as a monitor, not a gate.
- **Preference data (later).** The gym can emit *negative* trajectories (a wrong
  tool, a guessed coordinate, a skipped discovery) paired with the expert's correct
  one — ready-made DPO/RLAIF pairs once SFT plateaus.

## Risks & limitations (honest)

- **Screenshots are placeholders.** Auto-attached screenshots are represented as a
  textual marker, not pixels. This is deliberate (text SFT), and it reinforces the
  right lesson — read structure via `describe`/component-tree, not pixels — but a
  vision-capable Argent model would need real image observations layered in.
- **Simulator fidelity is a ceiling.** The gym models the screens and transitions
  the archetypes encode; it is not the real OS. Output formats are ported but can
  drift if Argent changes them — `spec/tools.json` and `format.ts` should be
  re-synced from the toolkit periodically (a CI check diffing against the live
  registry would catch schema drift).
- **Expert monoculture.** Every trajectory is the *one* optimal path. That's ideal
  for SFT but narrow; injected failures, multiple valid routes (the screen graph
  often has several), and later preference data widen the distribution.
- **Coverage is partial (40/67).** Documented and mechanical to extend; not a
  design limitation.

## TL;DR

Don't generate conversations — simulate the toolkit and roll out the policy inside
it, then refuse anything that isn't provably grounded and schema-valid. That makes
"high quality" a checkable property and "huge volume" a microsecond-per-sample
afterthought. The infra is here, validated, and deterministic; scaling it is
adding worlds and tasks, not rewriting the approach.
