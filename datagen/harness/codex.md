# Codex CLI — wire-format / harness spec

Reverse-engineered from the installed binary (`codex-cli 0.135.0`, Homebrew cask
`codex/0.135.0/codex-aarch64-apple-darwin`), its session rollout logs under
`~/.codex/sessions/**.jsonl` (the most authoritative source — they contain the
**actual `input[]` items** sent to the model), `~/.codex/config.toml`, and the
`openai/codex` GitHub repo at `ref=main` (`codex-rs/…`).

The rollout `.jsonl` lines wrap each Responses-API item as
`{"timestamp":…,"type":"response_item","payload":<ITEM>}`. The `payload` object
IS the wire item. Lines with `"type":"event_msg"` / `"turn_context"` /
`"session_meta"` are local telemetry, NOT sent to the model — but `turn_context`
is invaluable because it records the exact `approval_policy`, `sandbox_policy`,
`model`, `effort`, and the rendered `user_instructions` string for that turn.

---

## 1. API shape — OpenAI **Responses API** (`input[]` items)

Codex speaks the **Responses API** (`POST /v1/responses`), NOT Chat Completions.
The request carries `instructions` (the base system prompt), `input` (an array
of typed items), `tools` (flattened Responses-API tool defs), plus
`model`, `reasoning`, `store`, `stream`, `parallel_tool_calls`, etc.

Item `type`s observed in the `input[]` array, in conversation order:

| `payload.type`         | role        | meaning                                                       |
|------------------------|-------------|---------------------------------------------------------------|
| `message`              | `developer` | system/developer prompt fragments (permissions, app-context, collaboration_mode, skills) |
| `message`              | `user`      | AGENTS.md injection, `<environment_context>`, then the real user turn |
| `reasoning`            | —           | model reasoning: `summary[]`, `content` (null), `encrypted_content` |
| `function_call`        | —           | model tool call (name, arguments JSON string, call_id, optional namespace) |
| `function_call_output` | —           | tool result (call_id, output string OR multimodal content list) |

Key point: the base instructions go in the top-level Responses `instructions`
field (recorded in `session_meta.payload.base_instructions.text`), while the
**developer** and **user** `message` items carry the *injected context* (sandbox
permissions, env-context, AGENTS.md, skills list, collaboration mode).

Model output for a tool call is a `function_call` item streamed back; its
`arguments` is a **JSON-encoded string** (not an object). `call_id` is
`call_<22 alnum>`. Reasoning items come back with `encrypted_content` (an opaque
`gAAAA…` Fernet-style blob) which Codex round-trips back into `input[]` on the
next request so the model keeps its reasoning chain.

---

## 2. System / developer prompt (base instructions)

The base instruction text is model-specific and lives in `codex-rs/core/*.md`,
selected by model family. Captured verbatim from the repo (`ref=main`):

| file | opening line | char len |
|------|--------------|----------|
| `codex-rs/core/gpt_5_2_prompt.md` | `You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant.` | 21672 |
| `codex-rs/core/gpt-5.2-codex_prompt.md` | `You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.` | 7589 |
| `codex-rs/core/prompt_with_apply_patch_instructions.md` | `You are a coding agent running in the Codex CLI, a terminal-based coding assistant.` | 24008 |
| also present: `gpt_5_1_prompt.md`, `gpt-5.1-codex-max_prompt.md`, `gpt_5_codex_prompt.md` | | |

> NOTE on `base_instructions` override: in the captured **desktop** sessions the
> user had a `model_instructions_file` configured, so `base_instructions.text`
> was *their own* markdown, not the stock prompt. The canonical "You are
> Codex…" prompt is the repo file above; reproduce that for default behavior.

### Verbatim opening (`gpt-5.2-codex_prompt.md`, the leanest "You are Codex" prompt)

```
You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user's computer.

## General

- When searching for text or files, prefer using `rg` or `rg --files` respectively because `rg` is much faster than alternatives like `grep`. (If the `rg` command is not found, then use alternatives.)

## Editing constraints

- Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.
- Add succinct code comments that explain what is going on if code is not self-explanatory. …
- Try to use apply_patch for single file edits, but it is fine to explore other options …
- You may be in a dirty git worktree.
    * NEVER revert existing changes you did not make unless explicitly requested …
```

### Verbatim opening (`gpt_5_2_prompt.md`, the full prompt)

```
You are GPT-5.2 running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.

Your capabilities:

- Receive user prompts and other context provided by the harness, such as files in the workspace.
- Communicate with the user by streaming thinking & responses, and by making & updating plans.
- Emit function calls to run terminal commands and apply patches. Depending on how this specific run is configured, you can request that these function calls be escalated to the user for approval before running. More on this in the "Sandbox and approvals" section.

Within this context, Codex refers to the open-source agentic coding interface (not the old Codex language model built by OpenAI).

# How you work

## Personality

Your default personality and tone is concise, direct, and friendly. …
```

These prompts contain (verbatim, repo): `## AGENTS.md spec`, `## Planning`
(with `update_plan` tool guidance + high/low-quality plan examples),
`## Task execution`, `## Validating your work`, `## Ambition vs. precision`,
`## Presenting your work and final message` → `### Final answer structure and
style guidelines` (Section Headers / Bullets / Monospace / File References /
Structure / Tone / Verbosity / Don't), and `# Tool Guidelines` (`## Shell
commands`, `## apply_patch`, `## update_plan`).

### Developer-message injected fragments (verbatim, from a real session)

Codex sends multiple `developer` `message` items, each a separate
`input_text` content part. Captured verbatim:

**Permissions block** (sandbox + approval policy):
```
<permissions instructions>
Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.
Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.
</permissions instructions>
```

**Collaboration mode block** (`<collaboration_mode>`, gates `request_user_input`):
```
<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different `<collaboration_mode>...</collaboration_mode>` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

The `request_user_input` tool is unavailable in Default mode. …
</collaboration_mode>
```

**Skills block** (`<skills_instructions>` — lists every installed SKILL.md with
name/description/`(file: …path)`; this is how argent skills reach the model):
```
<skills_instructions>
## Skills
A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. …
### Available skills
- argent-simulator-setup: Set up and connect to an iOS simulator using argent MCP tools. … (file: /Users/…/SKILL.md)
…
</skills_instructions>
```

(Desktop-only extra: `<app-context>` block with `# Codex desktop context`,
image/markdown rendering rules, and the `automation_update` tool docs — present
only when `originator == "Codex Desktop"`. Skip for the CLI style.)

---

## 3. Tool definitions — flattened Responses-API shape

Tools serialize via the Rust enum `ToolSpec` (`codex-rs/tools/src/tool_spec.rs`,
`#[serde(tag = "type")]`). The result is the **flattened Responses-API shape**:
`{"type":"function","name":…,"description":…,"strict":…,"parameters":{…}}` —
NOT the Chat-Completions `{"type":"function","function":{…}}` nesting.

`ResponsesApiTool` fields: `name`, `description`, `strict` (hard-coded `false`
for all MCP/dynamic tools), `parameters` (a `JsonSchema`), optional
`defer_loading` (omitted when `None`). `output_schema` exists internally but is
`#[serde(skip)]` → never on the wire.

### `exec_command` (PTY/unified-exec tool) — verbatim shape

```json
{
  "type": "function",
  "name": "exec_command",
  "description": "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
  "strict": false,
  "parameters": {
    "type": "object",
    "properties": {
      "cmd":               { "type": "string",  "description": "Shell command to execute." },
      "workdir":           { "type": "string",  "description": "Working directory for the command. Defaults to the turn cwd." },
      "yield_time_ms":     { "type": "number",  "description": "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." },
      "max_output_tokens": { "type": "number",  "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." }
    },
    "required": ["cmd"],
    "additionalProperties": false
  }
}
```
(`JsonSchema::number` emits `"type":"number"` — there is no `integer`.) The
plain-shell variant `shell_command` uses `command` + `workdir` + `timeout_ms`.

### `apply_patch` — FREEFORM Lark-grammar custom tool (`"type":"custom"`)

```json
{
  "type": "custom",
  "name": "apply_patch",
  "description": "Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  "format": {
    "type": "grammar",
    "syntax": "lark",
    "definition": "start: begin_patch hunk+ end_patch\nbegin_patch: \"*** Begin Patch\" LF\n… (apply_patch.lark)"
  }
}
```
The model emits apply_patch as a `*** Begin Patch … *** End Patch` envelope, NOT
JSON. (Older/other model paths declare apply_patch as a normal function with a
`{"command":["apply_patch","*** Begin Patch…"]}` arg — see
`prompt_with_apply_patch_instructions.md`.)

### MCP tools (how argent surfaces) — name mangling

When `[mcp_servers.argent]` is configured, each argent tool becomes a Responses
function tool. Name mangling (`codex-rs/codex-mcp/src/mcp/mod.rs`,
`sanitize_responses_api_tool_name`): **every char that is not `[A-Za-z0-9_]` is
replaced with `_`**. So `list-devices`→`list_devices`, `gesture-tap`→
`gesture_tap`, `gesture-swipe`→`gesture_swipe`, `run-sequence`→`run_sequence`.

Two name forms (switched by `prefix_mcp_tool_names`):
- **Modern (observed in 0.135 sessions):** the `function_call` item carries a
  bare `name` (`list_devices`) plus a separate `"namespace": "mcp__argent"`
  field. Tool defs are nested under a `{"type":"namespace","name":"mcp__argent",
  "tools":[…]}` wrapper.
- **Legacy flat form:** `mcp__<server>__<tool>` (delimiter `"__"`), e.g.
  `mcp__argent__list_devices`. 64-byte cap; SHA-1(12-hex) suffix on collisions.

MCP tool `parameters` = the server's `input_schema`, with `"properties"` forced
to `{}` if missing. `strict:false`.

---

## 4. Assistant tool-call format (`function_call` item)

Shell tool call (verbatim from session, CLI 0.119):
```json
{
  "type": "function_call",
  "name": "exec_command",
  "arguments": "{\"cmd\":\"git status --short --branch && git branch --show-current && pwd\",\"workdir\":\"/Users/…/argent\",\"yield_time_ms\":1000,\"max_output_tokens\":2000}",
  "call_id": "call_mmSET2Sr5c4sAKmPRGQgmzRg"
}
```

MCP (argent) tool call (verbatim from session, CLI 0.135) — note the extra
`namespace` field and de-dashed `name`:
```json
{
  "type": "function_call",
  "name": "list_devices",
  "namespace": "mcp__argent",
  "arguments": "{}",
  "call_id": "call_pMGZxs8XGC13A0UUnBwEx8wV"
}
```
`arguments` is ALWAYS a JSON-encoded **string**, even for empty args (`"{}"`).

---

## 5. Tool-result framing + JUNK (`function_call_output`) — VERBATIM

### 5a. Shell output wrapper (string `output`)

CLI 0.119 (`exec_command` over a real shell — full header):
```
Command: /bin/zsh -lc 'git status --short --branch && git branch --show-current && pwd'
Chunk ID: d620f5
Wall time: 0.0000 seconds
Process exited with code 0
Original token count: 17
Output:
## HEAD (no branch)
/Users/ignacylatka/.codex/worktrees/07d5/argent
```
Wrapped as:
```json
{
  "type": "function_call_output",
  "call_id": "call_mmSET2Sr5c4sAKmPRGQgmzRg",
  "output": "Command: /bin/zsh -lc '…'\nChunk ID: d620f5\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 17\nOutput:\n## HEAD (no branch)\n/Users/…/argent\n"
}
```

CLI 0.135 dropped the `Command:` line (still present sometimes); a minimal
exec output looks like:
```
Chunk ID: cf0e23
Wall time: 0.0000 seconds
Process exited with code 0
Original token count: 3800
Output:
<stdout/stderr interleaved>
```

**Verbatim header lines (the JUNK):**
- `Command: <shell> -lc '<cmd>'`   (the literal command, when present)
- `Chunk ID: <6 hex>`
- `Wall time: <float> seconds`
- `Process exited with code <N>`   (omitted for MCP outputs)
- `Original token count: <N>`      (omitted for MCP outputs)
- `Output:`                        (literal separator before the body)

### 5b. Truncation marker — VERBATIM

When stdout exceeds `max_output_tokens`, Codex elides the **middle** of the
output and inserts (Unicode ellipsis `…`, NOT three ASCII dots):
```
…<N> tokens truncated…
```
Real example (head + tail kept, middle replaced):
```
…/argent/packages/tool-server/src/utils/react-profiler…1440 tokens truncated…/Users/…/.codex/worktrees/071e
```
So the literal junk is the regex `…\d+ tokens truncated…`.

### 5c. MCP (argent) output wrapper — string `output`

Lighter wrapper: only `Wall time:` + `Output:`, then the **raw MCP content array
JSON** (`[{"type":"text","text":"…"}]`) serialized into the string. No exit
code, no token count:
```json
{
  "type": "function_call_output",
  "call_id": "call_pMGZxs8XGC13A0UUnBwEx8wV",
  "output": "Wall time: 0.2211 seconds\nOutput:\n[{\"type\":\"text\",\"text\":\"{\\n  \\\"devices\\\": [ … ]\\n}\"}]"
}
```

### 5d. Multimodal MCP output (screenshots) — list `output`

When an argent tool (`launch_app`, `gesture_*`, `screenshot`, `describe`)
returns an image, `output` becomes a **list of content parts**, mixing
`input_text` and `input_image`. Verbatim shape (base64 truncated here only):
```json
{
  "type": "function_call_output",
  "call_id": "call_b9V4ket7fut9nkeyeuI0iOj9",
  "output": [
    { "type": "input_text",  "text": "Wall time: 3.2718 seconds\nOutput:" },
    { "type": "input_text",  "text": "{\n  \"launched\": true,\n  \"bundleId\": \"com.argent.bench2048\"\n}" },
    { "type": "input_text",  "text": "--- Screen after action ---" },
    { "type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg…", "detail": "high" },
    { "type": "input_text",  "text": "Saved: /tmp/claude-501/simserver-…/media/161793000-1780066076163.png" }
  ]
}
```
**Verbatim image junk:**
- `--- Screen after action ---`  (literal separator before each image)
- image part: `{"type":"input_image","image_url":"data:image/png;base64,…","detail":"high"}`
- trailing `Saved: <abs path>.png` text part with the on-disk screenshot path.

---

## 6. Other junk — env-context, user-instructions, AGENTS.md

These ride in **user** `message` items (separate `input_text` parts), inserted
before the real user turn.

**AGENTS.md injection** (verbatim — the repo's `<INSTRUCTIONS>`-wrapped form):
```
# AGENTS.md instructions for /Users/…/argent

<INSTRUCTIONS>
# Global Codex Instructions
…(full AGENTS.md body)…
</INSTRUCTIONS>
```

**`<environment_context>`** (verbatim, observed form in real sessions):
```
<environment_context>
  <cwd>/Users/ignacylatka/.codex/worktrees/07d5/argent</cwd>
  <shell>zsh</shell>
  <current_date>2026-04-10</current_date>
  <timezone>Europe/Warsaw</timezone>
</environment_context>
```
(Newer `main` `environment_context.rs` renders a richer schema with
`<filesystem>`, `<workspace_roots>`, `<permission_profile>`,
`<network enabled="true">`, `<approval_policy>` and XML-escaped values — the
sandbox/approval state can also appear here instead of/in addition to the
developer `<permissions instructions>` block. Reproduce the lean form above for
the captured 0.135-era style.)

**`user_instructions`** — the rendered AGENTS.md / global instructions string is
ALSO recorded in `turn_context.payload.user_instructions` (local telemetry, same
text as the `<INSTRUCTIONS>` block).

Approval / sandbox state is exposed three ways: (1) developer `<permissions
instructions>` block, (2) `turn_context.approval_policy` /
`sandbox_policy.type` (`never` / `danger-full-access` / `workspace-write`), (3)
optionally inside `<environment_context>`. Values seen: `approval_policy ∈
{never, untrusted, on-failure, on-request}`; `sandbox ∈ {danger-full-access,
workspace-write, read-only}`.

---

## 7. Capture method — validate a real request

1. **Read rollout logs (best, zero-setup).** Every session is logged verbatim
   to `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Each
   `{"type":"response_item","payload":…}` line is a real `input[]` item.
   Filter: `jq -c 'select(.type=="response_item") | .payload'`.
2. **Proxy the HTTPS request.** Point Codex at a logging proxy
   (`-c model_provider=…` or `OPENAI_BASE_URL` / `HTTPS_PROXY=http://127.0.0.1:8080`
   with mitmproxy) and read the raw `POST /v1/responses` body to see
   `instructions` + `input` + `tools` exactly as sent.
3. **`codex exec` for a clean one-shot.** `codex exec "list ios devices"` runs
   non-interactively; pair with the proxy or read its fresh rollout file.
4. **Repo cross-check.** `gh api repos/openai/codex/contents/<path>?ref=main -H
   "Accept: application/vnd.github.raw"` for the canonical prompt/tool source.

---

## Notes / surprises

- Rollout `.jsonl` payloads ARE the wire items — no proxy needed to recover the
  exact format.
- Two output wrappers coexist: heavy shell wrapper (`Command/Chunk ID/Wall
  time/Process exited with code/Original token count/Output`) vs. light MCP
  wrapper (`Wall time/Output` + raw MCP content-array JSON).
- MCP tool calls in 0.135 carry a **`namespace`** field (`mcp__argent`) AND a
  de-dashed bare `name` — dashes are not allowed in Responses tool names.
- Truncation elides the **middle** with `…N tokens truncated…` (Unicode `…`),
  not a head/tail `[... omitted N lines ...]` marker.
- Screenshots come back as multimodal `function_call_output.output` **lists**
  with a literal `--- Screen after action ---` separator and a trailing
  `Saved: <path>` text part; image parts use `"detail":"high"`.
- `apply_patch` is a `"type":"custom"` Lark-grammar tool, not a JSON function.
- `reasoning` items round-trip via `encrypted_content` (opaque `gAAAA…` blob).
- Tools are flattened Responses-API (`{"type":"function","name",…}`), not
  Chat-Completions nested.
