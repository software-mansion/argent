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

## Results

_Pending run._ The 4 local cells run autonomously this weekend (preliminary
heuristic scores); the 2 Haiku cells and the real LLM-judge re-score need the API key
(Monday). Final table lands in `RESULTS.md` + here.

## Status / caveats

- `run-cell.sh`/`judge.py` are first-draft glue around Hermes; the first cell is
  smoke-tested and adjusted before the full sweep (Hermes' transcript-export format and
  the `-t` toolset-isolation behavior are verified live, not assumed).
- Local 4B models may score low through a generic harness (the long toolkit system
  prompt + tool schemas are exactly what stressed Ollama's `num_ctx`); that gap is part
  of what the benchmark measures.
