# Argent fine-tune data generator

Synthetic training data for fine-tuning a model that **drives the Argent toolkit** —
iOS simulators, Android emulators, and Chromium apps — by emitting correct,
schema-valid, policy-compliant tool-call trajectories.

The headline goal is **super-high-quality data at huge volume**. We get both from
one idea: instead of asking an LLM to _write_ tool-use conversations (which
produces hallucinated tool schemas, ungrounded tap coordinates, and inconsistent
tool outputs), we built a **deterministic simulator of Argent** (a "gym") and let
an **expert policy** — the `.claude/rules/argent.md` workflow encoded as code —
roll out trajectories inside it. Every observation is produced by the simulator,
every tap coordinate is the centre of an element the simulator actually placed on
screen, and every trajectory passes a battery of validators before it ships.

```
600 trajectories generated + validated in ~0.5s on one core, 0 rejected.
=> ~1M trajectories in ~13 min single-threaded; embarrassingly parallel beyond that.
```

## Quickstart

Node 24+ (uses native TypeScript type-stripping — no build step). From this
directory:

```bash
# generate 800 train + 100 eval trajectories into ./out
node src/generate.ts --n 800 --evalN 100

# prove the validator actually rejects bad data (adversarial self-check)
node src/selfcheck.ts
```

Outputs in `out/`:

| file                         | what                                                                       |
| ---------------------------- | -------------------------------------------------------------------------- |
| `train.jsonl` / `eval.jsonl` | normalized trajectories (system + tools + messages)                        |
| `train.openai.jsonl`         | OpenAI fine-tune chat format (`tools` + `tool_calls`)                      |
| `train.sharegpt.jsonl`       | ShareGPT format (tool calls inlined) — for axolotl / LLaMA-Factory         |
| `stats.json`                 | tool coverage, task/platform/difficulty mix, length histogram, pass rate   |
| `samples.md`                 | human-readable rendering of the first N trajectories                       |
| `failures.jsonl`             | every rejected attempt with its validator reasons (never silently dropped) |

`--n`, `--evalN`, `--seed`, `--out`, `--samples`, `--emit openai,sharegpt` are the flags.

## What a trajectory looks like

A multi-turn agentic conversation:

- **system** — the condensed Argent operating policy (`src/system-prompt.ts`).
- **tools** — the tools offered for this example: every tool the trajectory uses
  plus a deterministic sample of distractors (default 28 total), so the model
  learns to _select_ from the real 67-tool surface.
- **messages** — `user` task → `assistant` (narration + `tool_calls`) → `tool`
  results → … → final `assistant` answer.

Tool schemas are the real ones, extracted from the live Argent registry into
`spec/tools.json` (the validation ground truth). Tool **outputs** reproduce the
real serializers (`describe` text-trees, `debugger-component-tree`, gesture
`{tapped,timestampMs}`, profiler markdown, `view-network-logs`, …) — ported in
`src/format.ts`.

## The quality gates (`src/validate.ts`)

A trajectory ships only if it passes **all** of:

1. **Schema** — every tool call validates against the real JSON Schema (ajv),
   **strictly** (unknown arguments are rejected, not ignored).
2. **Structure** — role ordering, `tool_call_id` pairing, final assistant turn.
3. **Device order** — `list-devices` precedes the first boot/launch/open.
4. **Policy** — coordinate ranges `[0,1]`; `run-sequence` steps use only allowed
   tools, carry no `udid`, and each inner step validates against its own schema.
5. **Grounding (the core gate)** — every `gesture-tap` coordinate must fall inside
   an element parsed from the _most recent discovery result_ (box containment for
   `describe`, tap-point proximity for `debugger-component-tree`). This is what
   makes the data provably non-hallucinated, and it _also_ enforces
   discovery-before-tap: a tap on a freshly-navigated screen can only be grounded
   by a discovery taken _on that screen_.

`selfcheck.ts` is the regression test for the gates: it corrupts a known-good
trajectory nine ways (ungrounded tap, missing discovery, schema break, unknown
arg, out-of-range coord, wrong device order, unknown tool, un-offered tool) and
asserts each is rejected. **A gate that passes everything is worthless** — this
keeps them honest.

## Architecture

```
spec/tools.json        real 67-tool catalog (name/description/inputSchema) — ground truth
src/format.ts          exact reproductions of Argent tool output formats
src/gym.ts             the simulator: execute(world, tool, args) -> observation (+ mutates world)
src/archetypes/*       app worlds as screen graphs (elements w/ normalized frames + nav edges)
src/world.ts           builds a device pool + runtime state for one trajectory
src/graph.ts           BFS routing through a screen graph
src/tasks.ts           task taxonomy + generator (kind × app × platform × difficulty × injected failure)
src/expert.ts          the oracle: argent.md rules as executable behavior, drives the gym
src/narrate.ts         natural-language surface forms (varies phrasing, never the action backbone)
src/validate.ts        schema + structural + policy + grounding gates
src/system-prompt.ts   the policy attached as the system message
src/emit.ts            assemble Trajectory + convert to OpenAI / ShareGPT
src/generate.ts        CLI: sample → solve → validate → write + stats
```

Determinism: the whole pipeline is a pure function of the seed (custom
`mulberry32` RNG, no `Date.now`/`Math.random`). Same seed ⇒ byte-identical output,
so runs are reproducible and shardable. Train/eval use disjoint seed ranges.

## Extending (this is the scale lever)

Coverage today is 40/67 tools across 16 task families. Adding more is mechanical:

- **New app archetype** — drop a file in `src/archetypes/` that default-exports an
  `AppArchetype` (screen graph; reuse `helpers.ts`), import it in `index.ts`.
- **New task family** — add a `TaskKind`, a builder in `tasks.ts`, a solver in
  `expert.ts` (reuse `ensureDevice` / `ensureLaunched` / `discover` / `tapKey`),
  a prompt bank in `narrate.ts`, and any missing gym transitions in `gym.ts`.
  Adding the five families that took coverage from 30→40 tools was ~150 lines.

The remaining 27 tools (see `stats.json#tools_never_used`) are the backlog:
`chromium-cookies/-storage`, the `native-*` devtools variants, profiler
drill-down query variants, `gesture-drag/-custom/-rotate`, `button`,
`gather-workspace-data`, the stop/update tools. Each follows the pattern above.

## LLM augmentation (cheap, safe)

The grounded backbone (tool calls + observations) is fixed and correct. To add
linguistic diversity, pass an LLM **only** the `user` prompt and the `assistant`
narration strings to paraphrase, then **re-validate** — the action/observation
backbone never changes, so correctness can't regress. This is the right place to
spend tokens; never let an LLM author the tool calls or outputs.

See `DESIGN.md` for the full rationale and the path to the proof model + scale-up.
