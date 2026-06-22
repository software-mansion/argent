# Toolkit × model benchmark — Argent vs agent-device, Silver vs Gemma 4 vs Haiku

Compares device-control agents on a suite of real iOS-Settings tasks, using **OpenCode**
as the agent harness (an established runtime — we do not reimplement the agent loop)
driving a model through a toolkit's MCP tools against a **real booted iOS simulator**,
plus a thin judge pass for task success.

**Full write-up + the silver fine-tuning journey: [RESULTS.md](./RESULTS.md).**

Matrix (2 toolkits × 3 models) — Argent column run; agent-device + Haiku pending:

|                  | **Argent** (MCP)       | **agent-device** (MCP) |
| ---------------- | ---------------------- | ---------------------- |
| **gemma4:e4b**   | **2/8 (25%)** baseline | pending (build)        |
| **silver:e4b**   | 0/8 — see RESULTS.md   | pending                |
| **Claude Haiku** | pending (key)          | pending (key)          |

Short version: the silver fine-tune was retrained until it became a true OpenCode drop-in
(native gemma4 tool format → executes tools; `--no-narration` → full multi-step), but the
4B model still wanders and completes 0/8 vs gemma's 2/8. The harness-compatibility problems
are solved; navigation quality is the open gap. Details + next steps in RESULTS.md.

## The setup that works (OpenCode + ollama + argent)

Getting a local model to actually _execute_ argent tools through OpenCode took three
fixes — the earlier "harness doesn't execute tool calls" conclusion was wrong; the real
cause was **context overflow** (the model never had room to emit a call):

1. **`OLLAMA_CONTEXT_LENGTH=32768` on the ollama _server_.** OpenCode's default "build"
   agent sends a ~34K-char system prompt + 117 tools (its built-ins + every configured
   MCP) with `max_tokens=32000`; at the default `num_ctx=4096` the prompt fills the
   context (`input=4095, output=1, finish=length`) and the model emits one token. (This
   is the same `num_ctx` issue baked into `silver:e4b`'s Modelfile.)
2. **A lean custom agent** (`~/.config/opencode/agent/argentbench.md`): `tools: {"*":
false, "argent_*": true}` (argent-only, 117→69 tools) and a ~600-char device-control
   prompt replacing the 34K build prompt. The **same agent for both models** → identical
   system prompt (only the weights differ).
3. **Direct ollama** (`baseURL http://localhost:11434/v1`), not a logging proxy (a
   non-streaming proxy hangs multi-turn runs); `radon`/`linear` MCP disabled.

With this, `gemma4:e4b` issues real structured `tool_calls`, OpenCode executes them
against the live sim (verified `tool_called`/`tool_result` in `~/.argent/mcp-calls.log`),
and it reports the correct live udid.

## Pieces

- `tasks.jsonl` — 8 toolkit-agnostic iOS-Settings tasks (zero-install, deterministic),
  each with a `goal` for the judge.
- `run-cell-opencode.sh <model> <agent> <out>` — runs the suite for one cell via headless
  `opencode run … --format json`, resetting the sim between tasks and saving each task's
  JSON event stream (tool calls + results + final text) + an after-screenshot.
- `judge.py` — parses the OpenCode JSON transcripts; scores task success via Claude
  (`ANTHROPIC_API_KEY`) or a labeled heuristic. Manual Claude judgement is used for the
  committed numbers below (no API spend before the key is supplied Monday).
- Agent file: `~/.config/opencode/agent/argentbench.md` (not in repo — see fix #2).

## Results so far

### Argent × gemma4:e4b — **2/8 (25%)** baseline

Honest per-task judgement of the transcripts (`out/argent_gemma4/`):

| task                 | verdict | note                                                          |
| -------------------- | ------- | ------------------------------------------------------------- |
| ios-version          | PASS    | navigated General→About via `describe`, reported iOS 18.5     |
| accessibility-option | PASS    | reached Accessibility, reported a real option (Motion)        |
| device-name          | fail    | 20-call loop, no answer                                       |
| airplane-on          | fail    | got lost near VPN & Device Management; toggle never confirmed |
| wifi-state           | fail    | empty answer after many blind swipes                          |
| appearance           | fail    | derailed by "Cannot read image" errors                        |
| search-bluetooth     | fail    | confused at end; Bluetooth screen not confirmed               |
| back-to-root         | fail    | 2 calls, empty answer                                         |

Non-zero, matching the team's prior "works but poorly." A recurring drag: every argent
interaction tool auto-returns a **screenshot image** the text-only ollama model can't read
("Cannot read image"), wasting turns — this handicaps gemma and silver **equally**, so the
comparison stays fair.

### Argent × silver — retrained to a true drop-in; 0/8 (see RESULTS.md)

The original `silver:e4b` could not tool-call in OpenCode at all (it was trained on a
bespoke `<tool_call>` text format + a user-turn preamble). It was **retrained** until it
became a true gemma drop-in — native gemma4 tool format (executes argent tools) and, with
`--no-narration`, full multi-step navigation. It still completes **0/8** (wanders,
hallucinates tool names, derailed by unreadable screenshots) vs gemma's 2/8. The complete
fine-tuning journey, root causes, and next steps are in **[RESULTS.md](./RESULTS.md)**.

## Run

```bash
# prereqs: ollama up with OLLAMA_CONTEXT_LENGTH=32768; iPhone 16 Pro Max booted;
#          argentbench agent installed; opencode ollama provider -> localhost:11434/v1
./run-cell-opencode.sh ollama/gemma4:e4b argentbench out/argent_gemma4
python3 judge.py out/argent_gemma4
```

**Memory:** serialized by design — 26 GB M4 Pro, no CUDA; an iOS sim + a 9.6 GB model +
32K KV cache fill most of it. One model at a time; kill orphaned `llama-server` runners
between models (they survive `ollama stop` and starve the next run).
