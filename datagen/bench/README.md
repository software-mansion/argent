# Toolkit × model benchmark — Argent vs agent-device, Silver vs Gemma 4 vs Haiku

Compares **6 cells = 2 device-control toolkits × 3 models** on a small suite of
real iOS-Settings tasks, using **Hermes** as the agent harness (an established
runtime — we do not reimplement the agent loop) plus a thin LLM-judge scoring pass.

|                  | **Argent** (MCP) | **agent-device** (MCP) |
| ---------------- | ---------------- | ---------------------- |
| **silver:e4b**   | local (Ollama)   | local (Ollama)         |
| **gemma4:e4b**   | local (Ollama)   | local (Ollama)         |
| **Claude Haiku** | API (key Monday) | API (key Monday)       |

`silver:e4b` is the Argent-fine-tuned Gemma 4 E4B; `gemma4:e4b` is the untuned base;
Claude Haiku is the strong-model reference. Running all three through the **same**
harness + toolkit is the apples-to-apples comparison (note: silver was trained for
Argent's specific tool-call format, so a generic harness is _off_ its home turf — a
deliberate real-world test of whether the specialization transfers).

## Pieces (no custom harness)

- **Harness:** Hermes (`~/dev/hermes-agent`, installed `~/.hermes`). One headless
  `hermes chat` run per task, isolated to a single MCP toolset via `-t`.
- `tasks.jsonl` — 8 toolkit-agnostic iOS-Settings tasks (zero-install, deterministic),
  each with a `goal` for the judge.
- `run-cell.sh <model> <toolkit> <out>` — runs the suite for one cell, saving each
  task's final answer + transcript (tool calls) via `hermes sessions export`.
- `judge.py` — LLM-as-judge scoring (Claude when `ANTHROPIC_API_KEY` is set; a labeled
  heuristic proxy otherwise) → `out/<cell>/scores.json` + a comparison table.
- `run-all.sh` — the 4 local cells, serialized, then scores.

## Prerequisites

1. **Ollama** running with both models: `ollama pull gemma4:e4b` (silver:e4b is built
   by `../training` — see that README).
2. **One iOS simulator booted** (iPhone 16 Pro Max), Settings app reachable.
3. **Toolkits installed**: `argent` and `agent-device` on PATH (both expose `<tool> mcp`).
4. **Hermes config** (`~/.hermes/config.yaml`):
   ```yaml
   model: { default: silver:e4b, provider: ollama-launch }
   providers:
     ollama-launch:
       api: http://127.0.0.1:11434/v1
       default_model: silver:e4b
       models: [silver:e4b, gemma4:e4b]
     anthropic: {} # key via ~/.hermes/.env ANTHROPIC_API_KEY (Monday)
   mcp_servers:
     argent: { command: argent, args: [mcp] }
     agent-device: { command: agent-device, args: [mcp] }
   agent: { max_turns: 18 }
   ```

## Run

```bash
./run-all.sh                       # 4 local cells + scoring
# one cell:
./run-cell.sh silver:e4b argent out/argent_silvere4b
python3 judge.py out/argent_silvere4b
# Haiku (Monday, with the key in ~/.hermes/.env):
./run-cell.sh claude-haiku argent out/argent_haiku --provider anthropic
ANTHROPIC_API_KEY=… python3 judge.py out/*/   # re-judge everything with the real LLM judge
```

**Memory:** serialized by design — 26 GB M4 Pro, no CUDA; an iOS sim + Ollama + Hermes
already fill a lot, and overload has paniced this machine. Never run two cells at once.

## Status — harness integration is the blocker (findings 2026-06-19)

End-to-end smoke tests (real iPhone 16 Pro Max booted, real argent tool-server up)
surfaced a real obstacle: **neither installed harness executes the local models' tool
calls against argent**, so the local cells can't be scored as-is. Verified, not assumed:

- **Hermes** loads the MCP tools into context (argent `list_tools` = 69 tools) but never
  executes the local ollama models' tool calls. Both `silver:e4b` and `gemma4:e4b` (base)
  **hallucinate** the agent loop — they emit a tool call as text, then fabricate a
  plausible tool _response_ and keep going. silver produced gym-style fakes (a
  non-existent udid `7F845A92…`, 2025-era timestamps); the **real sim was never touched**
  (foreground stayed Spotlight) and argent's call log shows **only `list_tools`, zero
  executions**. Hermes' ollama tool-call→execution path simply doesn't fire for these.
- **OpenCode** (after adding an ollama provider): silver emits text only, again **zero
  executed tool calls** (only `list_tools` in argent's log).

**Root cause:** `silver:e4b` is specialized for **Argent's `<tool_call>` text protocol**
with the Argent policy + tool list in its **SYSTEM** (baked into the Modelfile). A generic
harness injects its _own_ system prompt + tool schemas and expects its _own_ tool-call
format, which silver doesn't match — so it never produces a harness-executable call.
(`gemma4:e4b` base is additionally just weak — it emitted a garbled tool name.) Claude
Haiku, using each harness's native tool-calling, would not hit this.

**This is itself a result:** a format-specialized small model does **not** drop into a
generic agent harness and execute tools. silver works in its _native_ loop — the gym eval
(60.3% nav, see `../training/results/RESULTS-e4b.md`) and the deployed Ollama model driven
by a thin `<tool_call>`-parsing loop.

### Decision needed (Monday)

The "use an established harness" constraint conflicts with silver's format specialization.
Options, fairest first:

1. **One Argent-format loop for all models** — adapt `../training/eval.ts` to drive a
   _real_ device via the argent tool-server (instead of the gym), using the Argent preamble
   - `<tool_call>` parsing. Same loop for silver / gemma4 / Haiku → apples-to-apples, and it
     works for silver. Caveat: it's a thin custom loop (reuses the existing scored harness),
     which bends the "no custom harness" rule — but that rule is exactly what silver's format
     breaks. **Recommended.**
2. **Adjust Hermes/OpenCode** to (a) use the Argent preamble as the system prompt and
   (b) parse silver's `<tool_call>` text → execute. This is the "adjust the harness" path,
   but it reaches into each harness's internal tool-call + system-prompt handling.
3. **Harness-per-model** (silver native, others via Hermes/OpenCode) — not apples-to-apples.

Scaffolding (`tasks.jsonl`, `run-cell.sh`, `judge.py`) stands; what changes is the runner's
backend once the harness question is settled. The Anthropic key for the Haiku cells is also
needed (an `ANTHROPIC_API_KEY` is present in `~/.hermes/.env` but left unused per the
"supply on Monday" note).
