# Serving `silver:e4b`

Two OpenAI-compatible servers, picked by hardware:

| Server                     | Where                    | Why                                                                          |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| **vLLM** (`serve-vllm.sh`) | Linux + CUDA GPU         | The Gemma team's recommended dev/test server; fast batched inference.        |
| **MLX** (`serve-mlx.sh`)   | this Mac (Apple Silicon) | vLLM has no Apple-Silicon build; MLX is Apple's own and fast on M-series.    |
| Ollama (`silver:e4b`)      | anywhere                 | Easiest to share/run (`ollama run silver:e4b "<task>"`); see `../README.md`. |

Both expose `POST /v1/chat/completions`, so the same client works against either
(just change the base URL/port: vLLM `:8000`, MLX `:8080`).

## Driving it as an Argent agent

The model is trained to emit **`<tool_call>{...}</tool_call>` as plain text** (not the
OpenAI structured `tool_calls` field), so you don't enable a vLLM tool-call parser —
the agent loop parses the tags itself. Each turn:

1. System message = the Argent policy + tool list in [`argent-system.txt`](./argent-system.txt)
   (regenerate with `FLAVOR=gemma4 node ../make-modelfile.ts`, which also writes it).
2. User message = the task (first turn), then each `<tool_response>…</tool_response>`.
3. Read the model's `<tool_call>` block, execute it against Argent, feed the result
   back as the next user turn. Stop when the model replies with plain text and no call.

Greedy (`temperature: 0`) for deterministic, schema-valid calls.

```bash
# one turn against either server (MLX shown; use :8000 for vLLM)
SYS=$(cat argent-system.txt)
curl -s http://127.0.0.1:8080/v1/chat/completions -H 'Content-Type: application/json' -d @- <<JSON | jq -r '.choices[0].message.content'
{ "model": "silver-e4b", "temperature": 0, "max_tokens": 160,
  "messages": [
    { "role": "system", "content": $(jq -Rs . <<<"$SYS") },
    { "role": "user", "content": "In the Settings simulator, open General and tap About." }
  ] }
JSON
# -> First, let me see what devices are available.
#    <tool_call>{"name":"list-devices","arguments":{}}</tool_call>
```

The reference agent loop (parse `<tool_call>`, ground taps, feed `<tool_response>`) is
`../eval.ts` — the same harness used to score the model through the gym.

## Notes

- **vLLM gemma4 support** is recent: `Gemma4ForCausalLM` is in vLLM's model registry
  as of v0.23 / current main. Older vLLM rejects the architecture.
- **vLLM does not run on this Mac** (no Apple-Silicon wheel, no Metal backend). It's
  the right choice on your GPU/Linux infra; MLX is the local equivalent here.
- vLLM and MLX both serve from the same merged `Gemma4ForCausalLM` weights
  (`LatekVo/silver` on the Hub, or local `fused/silver-e4b-causal`).
