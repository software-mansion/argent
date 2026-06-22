# Benchmark results — Argent × {gemma4:e4b, silver}

Device-control agents on 8 real iOS-Settings tasks, driven by **OpenCode** (the agent
harness) through Argent's MCP tools against a live iPhone 16 Pro Max simulator. Same
agent (`argentbench`, argent-only tools, identical system prompt for every model — only
the weights differ). Task success judged from the OpenCode transcripts (Claude as judge).

## Headline

| model (Argent toolkit)                     | success       | what it does                             |
| ------------------------------------------ | ------------- | ---------------------------------------- |
| **gemma4:e4b** (untuned base)              | **2/8 (25%)** | works but poorly                         |
| silver — original (`<tool_call>` text fmt) | 0/8           | **can't tool-call** (narrates)           |
| silver — native fmt (format fix)           | 0/8           | executes tools, **stops after 1 call**   |
| silver — native + no-narration             | 0/8           | **full multi-step**, but wanders / fails |

The fine-tune fixed every **harness-compatibility** problem but did **not** make silver a
better navigator than the base — it's currently worse (0/8 vs 2/8). Honest and instructive.

## The journey (each step a real fix, verified end-to-end)

1. **gemma baseline — 25%.** (My earlier "harnesses don't execute tool calls" claim was
   wrong; I'd never tested OpenCode+gemma.) The real blocker was **context overflow**:
   OpenCode's build agent sent 34K-char prompt + 117 tools at the default `num_ctx=4096`,
   so the model got 1 output token. Fix: `OLLAMA_CONTEXT_LENGTH=32768` + a lean argent-only
   agent. gemma then drives the sim — completes `ios-version` and `accessibility-option`,
   fails the rest (loops, blind swipes, derailed by unreadable screenshots).

2. **Silver couldn't tool-call at all.** The gym trained silver on a bespoke format (Argent
   preamble in the user turn + `<tool_call>` **text**) that no standard harness parses, so
   silver narrated and executed nothing (0 tool calls). No packaging/parser trick fixed it.

3. **Format fix — silver executes tools.** Retrained on gemma4's **native** tool format:
   `prepare-native.ts` emits proper `{messages, tools}` (system rules + structured
   `tool_calls` + tool-role results); mlx-lm's ChatDataset renders it via the gemma4 chat
   template into `<|tool_call>call:NAME{args}<tool_call|>` — exactly what OpenCode/ollama
   send and `PARSER gemma4` parses. silver-native is now a **true drop-in for gemma** (same
   renderer + parser, only weights differ) and **executes argent tools in OpenCode**. But it
   **stopped after ~1 call**: it did `list-devices`, then narrated the next step ("First,
   I'll launch Settings.") and ended the turn without emitting the call.

4. **Persistence fix — silver does multi-step.** The model conflated mid-task narration with
   a narration-only final answer. `--no-narration` strips prose from tool-call turns (a call
   is only a call; prose only in the final answer). silver-nonarr then does **full multi-step
   navigation** (one task: 17 calls — list-devices → launch-app → describe → swipe → tap →
   describe …), correctly reading udids from results.

5. **Remaining gap — navigation quality.** silver-nonarr still **fails every task** (0/8): it
   wanders, **hallucinates tool names** (`app-clear-ios-settings`, `argent$list-devices` —
   not real argent tools), is derailed by the unreadable screenshot images every interaction
   returns, and rambles instead of finishing. It is a weak navigator.

## Why silver (60% in the gym) underperforms gemma in the real harness

- **Domain mismatch on tool _outputs_.** The gym feeds clean, compact text observations;
  real argent returns verbose output (incl. an update notice) and, on every interaction, a
  **screenshot image** a text-only ollama model can't read ("Cannot read image"). silver was
  never trained on that messiness; gemma (stronger base) copes better.
- **Tool-set mismatch.** Trained on 8-tool subsets (to bound the verbose gemma4 tool
  rendering within 26 GB training memory), inferred against 69 argent tools → it confabulates
  tool names.
- **Capacity.** A 4B model taught the expert's clean happy-paths doesn't generalize to
  real-device noise; the 60% gym score measured its own idealized format, not the live harness.

## What would make silver beat gemma (next steps)

1. Train on **real argent tool outputs** (capture them; replace the gym's idealized text),
   so the model is in-distribution at inference.
2. Handle the **screenshot-image** problem for text-only models (drop auto-screenshots, or go
   to a vision model fed real PNGs — the gym already holds ground-truth layouts).
3. Train against the **real tool set** it will see at inference (or restrict OpenCode to the
   trained nav subset) to stop tool-name hallucination.
4. More data / iters, or a stronger base.

## Artifacts

- Models (ollama): `silver-native:e4b` (format fix), `silver-nonarr:e4b` (+ persistence).
- Adapters: `training/adapters/silver-native`, `training/adapters/silver-nonarr`.
- Data gen: `training/prepare-native.ts` (`--no-narration`); package: `training/package-native.sh`.
- Transcripts + per-task verdicts: `out/argent_{gemma4,silver_native,silver_nonarr}/`.
- Deferred (need the API key, Monday): the 2 **Claude Haiku** cells + an LLM-judge re-score;
  the **agent-device** toolkit column (needs `pnpm build`).
