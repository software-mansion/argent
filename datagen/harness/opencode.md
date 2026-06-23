# OpenCode harness wire format

Reverse-engineered from source at `/Users/ignacylatka/dev/opencode` (commit `c6083a474`),
verified against the user's real config at `~/.config/opencode/opencode.json`.

Goal: render device-control (argent MCP) trajectories EXACTLY as OpenCode presents them to a
local ollama / OpenAI-compatible (`/v1`) model, so training data is byte-for-byte faithful.

All file:line references below are into `packages/opencode/src/` unless noted.

---

## 1. API shape — OpenAI Chat Completions via the Vercel AI SDK

For a local **ollama** or **OpenAI-compatible** `/v1` model, OpenCode:

- Uses the Vercel **AI SDK** (`ai` package) — the live request is `streamText({ model, messages, tools, toolChoice, providerOptions, headers })` at `session/llm.ts:280` (import at `session/llm.ts:9`).
- Resolves the provider package to **`@ai-sdk/openai-compatible`** (`createOpenAICompatible(...).languageModel(id)`), `provider/provider.ts:117`, default fallback `provider/provider.ts:1180`/`:1397`. There is **no** `ollama-ai-provider`; ollama is just an OpenAI-compatible endpoint.
- `@ai-sdk/openai-compatible` POSTs the **OpenAI Chat Completions** schema to `{baseURL}/chat/completions`:
  - `messages[]` (roles: `system`, `user`, `assistant`, `tool`)
  - `tools[]` of `{ "type": "function", "function": { "name", "description", "parameters" } }`
  - assistant emits `tool_calls[]` of `{ id, type:"function", function:{ name, arguments } }`
  - tool results come back as `{ role:"tool", tool_call_id, content }`

The model object is built generically at `provider/provider.ts:1804` (`sdk.languageModel(model.api.id)`) — **no** Responses-API override (that override is only forced for `@ai-sdk/openai` OAuth, `provider/provider.ts:206`).

There is an opt-in flag-gated alternate native runtime (`@opencode-ai/llm`, `session/llm.ts:226` `if (flags.experimentalNativeLlm)`) — **default off**; it also routes openai-compatible through chat-completions.

### How the user configured ollama (verbatim from `~/.config/opencode/opencode.json`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow",
  "mcp": {
    "argent": { "type": "local", "command": ["argent", "mcp"], "enabled": true }
  },
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": { "silver:e4b": { "name": "silver:e4b" }, /* … */ }
    }
  }
}
```

Config schema for a provider entry: `packages/core/src/v1/config/provider.ts:76-121` (`npm`, `name`, `api`,
`env`, `models`, `options{apiKey,baseURL,timeout,…}`). `baseURL` is read in `provider/provider.ts:1647-1668`.

---

## 2. System prompt

### 2.1 Selection — which base prompt for ollama

`session/system.ts:25-39` (`SystemPrompt.provider(model)`) selects by `model.api.id` substring:

| match on `model.api.id` | prompt file |
|---|---|
| `gpt-4`, `o1`, `o3` | `beast.txt` |
| `gpt` + `codex` | `codex.txt` |
| `gpt` | `gpt.txt` |
| `gemini-` | `gemini.txt` |
| `claude` | `anthropic.txt` |
| `trinity` (lowercased) | `trinity.txt` |
| `kimi` (lowercased) | `kimi.txt` |
| **everything else (e.g. ollama `silver:e4b`, `gemma4:e4b`)** | **`default.txt`** |

So for the user's ollama models the base prompt is **`session/prompt/default.txt`** (8528 bytes, 96 lines). It is reproduced verbatim in §2.4.

### 2.2 Assembly order (the FULL system string)

Two layers stack:

1. `session/prompt.ts:1327-1333` builds `input.system` =
   `[...env, ...instructions, ...(skills ? [skills] : [])]`
   - `env` = `SystemPrompt.environment(model)` → the env preamble (§2.3), `session/system.ts:55-92`
   - `instructions` = `Instruction.system()` → AGENTS.md / CLAUDE.md / rule files content (project + global)
   - `skills` = skill catalog blurb (only if the agent has the `skill` permission)
   - `STRUCTURED_OUTPUT_SYSTEM_PROMPT` appended if the turn requests `json_schema` output

2. `session/llm/request.ts:56-66` collapses everything to **one** string:
   ```js
   const system = [
     [
       ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(input.model)),
       ...input.system,                                  // = env + instructions + skills, from step 1
       ...(input.user.system ? [input.user.system] : []),
     ].filter((x) => x).join("\n"),
   ]
   ```
   Final order (default agent): **default.txt → env preamble → AGENTS.md/instructions → skills**.

3. Sent as messages: `request.ts:101-112` prepends `system.map(x => ({ role:"system", content:x }))` to
   `input.messages`. Normally **one** `role:"system"` message (the joined string). It is NOT passed via the
   AI SDK `system:` param. A plugin hook (`experimental.chat.system.transform`) can grow it to **at most 2**
   system messages (`request.ts:74-78`); the default ollama path has no such plugin → exactly **1**.

### 2.3 Env preamble — VERBATIM template (`session/system.ts:61-72`)

```
You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}
Here is some useful information about the environment you are running in:
<env>
  Working directory: ${ctx.directory}
  Workspace root folder: ${ctx.worktree}
  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}
  Platform: ${process.platform}
  Today's date: ${new Date().toDateString()}
</env>
```

- `model.api.id` = the model name, e.g. `silver:e4b`. `model.providerID` = the provider config key, e.g. `ollama`.
  So line 1 renders e.g. `…model named silver:e4b. The exact model ID is ollama/silver:e4b`.
- `Platform` is Node `process.platform` → `darwin` / `linux`.
- `Today's date` is JS `Date.toDateString()` → e.g. `Mon Jun 23 2026`.
- Note the leading TWO-SPACE indent on the `<env>` body lines.
- If the project defines references with descriptions, a second `<available_references>` block follows
  (`session/system.ts:73-90`); none in the default case.

### 2.4 default.txt — VERBATIM (base prompt for ollama models)

```
You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

If the user asks for help or wants to give feedback inform them of the following:
- /help: Get help with using opencode
- To give feedback, users should report the issue at https://github.com/anomalyco/opencode/issues

When the user directly asks about opencode (eg 'can opencode do...', 'does opencode have...') or asks in second person (eg 'are you able...', 'can you do...'), first use the WebFetch tool to gather information to answer the question from opencode docs at https://opencode.ai

# Tone and style
You should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it, to make sure the user understands what you are doing (this is especially important when you are running a command that will make changes to the user's system).
Remember that your output will be displayed on a command line interface. Your responses can use GitHub-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like Bash or code comments as means to communicate with the user during the session.
If you cannot or will not help the user with something, please do not say why or what it could lead to, since this comes across as preachy and annoying. Please offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences.
Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request. If you can answer in 1-3 sentences or a short paragraph, please do.
IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.
IMPORTANT: Keep your responses short, since they will be displayed on a command line interface. You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as "The answer is <answer>.", "Here is the content of the file..." or "Based on the information provided, the answer is..." or "Here is what I will do next...". Here are some examples to demonstrate appropriate verbosity:
<example>
user: what is 2+2?
assistant: 4
</example>

<example>
user: is 11 a prime number?
assistant: Yes
</example>

<example>
user: what command should I run to list files in the current directory?
assistant: ls
</example>

<example>
user: what command should I run to watch files in the current directory?
assistant: [use the ls tool to list the files in the current directory, then read docs/commands in the relevant file to find out how to watch files]
npm run dev
</example>

<example>
user: what files are in the directory src/?
assistant: [runs ls and sees foo.c, bar.c, baz.c]
user: which file contains the implementation of foo?
assistant: src/foo.c
</example>

<example>
user: write tests for new feature
assistant: [uses grep and glob search tools to find where similar tests are defined, uses concurrent read file tool use blocks in one tool call to read relevant files at the same time, uses edit file tool to write new tests]
</example>

# Proactiveness
You are allowed to be proactive, but only when the user asks you to do something. You should strive to strike a balance between:
1. Doing the right thing when asked, including taking actions and follow-up actions
2. Not surprising the user with actions you take without asking
For example, if the user asks you how to approach something, you should do your best to answer their question first, and not immediately jump into taking actions.
3. Do not add additional code explanation summary unless requested by the user. After working on a file, just stop, rather than providing an explanation of what you did.

# Following conventions
When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library. For example, you might look at neighboring files, or check the package.json (or cargo.toml, and so on depending on the language).
- When you create a new component, first look at existing components to see how they're written; then consider framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries. Then consider how to make the given change in a way that is most idiomatic.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository.

# Code style
- IMPORTANT: DO NOT ADD ***ANY*** COMMENTS unless asked

# Doing tasks
The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:
- Use the available search tools to understand the codebase and the user's query. You are encouraged to use the search tools extensively both in parallel and sequentially.
- Implement the solution using all tools available to you
- Verify the solution if possible with tests. NEVER assume specific test framework or test script. Check the README or search codebase to determine the testing approach.
- VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck, ruff, etc.) with Bash if they were provided to you to ensure your code is correct. If you are unable to find the correct command, ask the user for the command to run and if they supply it, proactively suggest writing it to AGENTS.md so that you will know to run it next time.
NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.

- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are NOT part of the user's provided input or the tool result.

# Tool usage policy
- When doing file search, prefer to use the Task tool in order to reduce context usage.
- You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. When making multiple bash tool calls, you MUST send a single message with multiple tools calls to run the calls in parallel. For example, if you need to run "git status" and "git diff", send a single message with two tool calls to run the calls in parallel.

You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail.

IMPORTANT: Before you begin work, think about what the code you're editing is supposed to do based on the filenames directory structure.

# Code References

When referencing specific functions or pieces of code include the pattern `file_path:line_number` to allow the user to easily navigate to the source code location.

<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the `connectToServer` function in src/services/process.ts:712.
</example>
```

### 2.5 Custom agent prompt (`~/.config/opencode/agent/*.md`) — REPLACES the base prompt

Custom agents are loaded from `{agent,agents}/**/*.md` (`config/agent.ts:13`). The markdown is parsed as
YAML-frontmatter + body (`config/agent.ts:26-27`): frontmatter fields are merged into the agent config and
**the markdown body (trimmed) becomes `agent.prompt`** (`config/agent.ts:27` `prompt: md.content.trim()`).

In `request.ts:60`, when `input.agent.prompt` is set, it is used **instead of** `SystemPrompt.provider(model)`
— i.e. the custom body **fully replaces** `default.txt`. The env preamble, instructions, and skills are STILL
appended after it (they live in `input.system`, not in the base slot). So:

- **Default agent:** `default.txt` + env + AGENTS.md + skills
- **Custom agent:** `<agent.md body>` + env + AGENTS.md + skills

The user's real custom agent `~/.config/opencode/agent/argentbench.md` (verbatim body):

```
You drive iOS simulators, Android emulators, and Chromium apps using the Argent tools to complete the user's task on a real device.

Rules:
- Call argent_list-devices first; boot only if nothing is running.
- Open apps with argent_launch-app or argent_open-url. Never guess tap coordinates.
- Before tapping, call argent_describe and tap an element's centre (tap_x = frame.x + frame.width/2, tap_y = frame.y + frame.height/2). Coordinates are normalized 0-1.
- Re-run argent_describe after the screen changes (navigation, scroll, back). If a tap doesn't change the screen, re-describe instead of retrying the same spot.
- When the task is done, reply with a short plain-text answer and no tool call.
```

Its frontmatter `tools:` map whitelists exactly the namespaced names (`argent_describe`, `argent_gesture-tap`,
…) — confirming the namespacing rule below end-to-end.

---

## 3. Tool definitions — MCP namespacing & serialization

### 3.1 Namespacing rule (THE rule)

`mcp/index.ts:646`:

```js
const key = McpCatalog.sanitize(clientName) + "_" + McpCatalog.sanitize(mcpTool.name)
```

- Template: **`${sanitize(serverName)}_${sanitize(toolName)}`** — joined by a single underscore `_`.
- `clientName` = the MCP server's config key (e.g. `"argent"`). `mcpTool.name` = the raw MCP tool name (e.g. `"gesture-tap"`).
- `sanitize` (`mcp/catalog.ts:110`): `value.replace(/[^a-zA-Z0-9_-]/g, "_")` — any char NOT in `[a-zA-Z0-9_-]`
  becomes `_`. **Dashes (`-`) and underscores (`_`) are PRESERVED.** Dots/colons/spaces → `_`.
- **No length truncation** on tool names anywhere.
- This `key` is the entry in the tool map (`session/tools.ts`) and is sent verbatim as the function name.

Examples (argent MCP server):

| raw MCP tool | name sent to model |
|---|---|
| `list-devices` | `argent_list-devices` |
| `describe` | `argent_describe` |
| `gesture-tap` | `argent_gesture-tap` |
| `gesture-swipe` | `argent_gesture-swipe` |
| `launch-app` | `argent_launch-app` |
| `open-url` | `argent_open-url` |

(Prompts/resources use `:` instead of `_` — `catalog.ts:103` — but those are NOT callable tools, so irrelevant here.)

On invocation the AI SDK calls `execute`, which calls the MCP server with the **original** name (no prefix):
`client.callTool({ name: mcpTool.name, arguments: args })` (`catalog.ts:54-58`).

### 3.2 Per-tool serialized shape

`mcp/catalog.ts:42-52` (`convertTool`):

```js
return dynamicTool({
  description: mcpTool.description ?? "",        // MCP server's description, verbatim (or "")
  inputSchema: jsonSchema({
    ...mcpTool.inputSchema,
    type: "object",
    properties: mcpTool.inputSchema.properties ?? {},
    additionalProperties: false,
  }),
  execute: async (args) => { /* calls back to MCP */ },
})
```

The AI SDK serializes each map entry into the OpenAI `tools[]` request as:

```json
{
  "type": "function",
  "function": {
    "name": "argent_gesture-tap",
    "description": "<exact description the argent MCP server advertises>",
    "parameters": { "type": "object", "properties": { … }, "additionalProperties": false }
  }
}
```

- `function.parameters` = the MCP tool's JSON Schema, forced to `type:"object"` + `additionalProperties:false`.
- For openai-compatible/ollama the schema is **NOT** further sanitized (`sanitizeOpenAISchema` runs only for
  `@ai-sdk/openai`/`@ai-sdk/azure`; Gemini/Moonshot have their own) — `provider/transform.ts` schema path. So
  the MCP schema passes through essentially as-is.
- The MCP server's tool description is passed **verbatim** as `description`.

---

## 4. Assistant tool-call output format

The model is expected to emit standard OpenAI `tool_calls` on the assistant message:

```json
{
  "role": "assistant",
  "content": "",
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": { "name": "argent_describe", "arguments": "{}" }
    }
  ]
}
```

Quirks:
- **OpenCode does NOT mint or prefix tool-call IDs** on the request path. IDs come from the AI SDK / model
  output verbatim. (Only Claude/Mistral get ID *scrubbing* — `transform.ts:190` / `:223-228` — which does NOT
  apply to ollama/openai-compatible.) So whatever `id` the local model emits is used as-is and echoed back in
  the `tool` result's `tool_call_id`.
- `function.arguments` is a JSON **string** (OpenAI convention), even for no-arg tools (`"{}"`).

---

## 5. Tool-result framing + JUNK (most important)

### 5.1 Normal tool result → `role:"tool"` message

A completed tool call is stored as an assistant-message part `type:"tool-<name>"`, `state:"output-available"`,
with `toolCallId`, `input`, `output` (`session/message-v2.ts:326-334`). The whole message list is then run
through the AI SDK's `convertToModelMessages` (`message-v2.ts:417`), which emits the actual `role:"tool"`
message. `toModelOutput` (`message-v2.ts:172-204`) maps:

- string output → `{ type:"text", value: <output> }` → wire `content` is the plain string.
- object `{text, attachments}` → `{ type:"content", value:[ {type:"text"}, {type:"media"} … ] }`.

So a normal argent tool result on the wire:

```json
{ "role": "tool", "tool_call_id": "call_abc123", "content": "<tool output string>" }
```

(The AI SDK may render `content` as a string or as `[{type:"text",text:…}]` depending on adapter version;
the openai-compatible adapter sends the text value.)

### 5.2 Error framing

There is **no** `"ERROR:"` prefix and **no** `isError` boolean on the normal error path. A failed tool uses a
distinct part `state:"output-error"` with `errorText` (`message-v2.ts:348-358`). For an MCP tool that returned
`isError`, `catalog.ts:68-73` throws with the joined text content (or the literal `"MCP tool returned an error"`
if empty), and that message becomes `errorText`. Hardcoded placeholders:

- `"[Tool execution was interrupted]"` — `message-v2.ts:368` (pending/running tool at serialization time).
- `"[Old tool result content cleared]"` — `message-v2.ts:305` (compacted tool result).

### 5.3 Image / media from a tool result — VERBATIM junk

Two distinct mechanisms.

**(a) Media-not-supported-in-tool-result → re-injected as a synthetic USER message.**
`message-v2.ts:48`:
```
Attached media from tool result:
```
When a completed tool part carries media attachments and the model's provider is NOT in the
`supportsMediaInToolResult` allowlist (`message-v2.ts:158-170` — only anthropic/openai/bedrock/xai/
google-vertex-anthropic/gemini-3), the media is pulled out and pushed as a **separate `role:"user"` message**
right after the assistant message (`message-v2.ts:393-410`): a leading text part with the exact string above,
followed by `type:"file"` parts. **`@ai-sdk/openai-compatible` (ollama) is NOT in the allowlist → ollama
always takes this path: a tool that returns a screenshot becomes a follow-up user message
"Attached media from tool result:" + the image file.**

**(b) Model can't read the modality at all → text-error substitution.** `provider/transform.ts:399-405`
(`unsupportedParts`, applied last in `message()` at `transform.ts:431`):
```js
if (model.capabilities.input[modality]) return part
const name = filename ? `"${filename}"` : modality
return { type:"text", text:`ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.` }
```
Rendered for an image with no filename → exactly:
```
ERROR: Cannot read image (this model does not support image input). Inform the user.
```
(With a filename it becomes `ERROR: Cannot read "shot.png" (this model does not support image input). Inform the user.`)
This gates on `model.capabilities.input[modality]` (per-model input-modality map), NOT a flat `attachment` flag.
**For a text-only ollama model that returns a screenshot, the image is first re-injected as a user message via
(a), then (b) replaces it with this `ERROR: Cannot read image …` text — so the model literally sees the error
string, not the image.**

Adjacent image-error literals:
- `transform.ts:389` — `ERROR: Image file is empty or corrupted. Please provide a valid image.` (empty base64).
- `processor.ts:591` — `${output}\n\n[${n} image(s) omitted: could not be resized below the image size limit.]`
  (appended when an image couldn't be resized under the cap).

### 5.4 Output truncation — VERBATIM markers + limits

`tool/truncate.ts:15-16`:
```js
export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024   // 51200 bytes = 50 KB
```
Overridable via config `tool_output.max_lines` / `tool_output.max_bytes` (`truncate.ts:79-82`). Truncation
fires when `lines > maxLines || bytes > maxBytes` (`truncate.ts:93`). The full output is written to a temp file;
the wire content (head direction, `truncate.ts:136`):
```
${preview}

...${removed} ${unit} truncated...

${hint}
```
where `unit` ∈ {`lines`,`bytes`} and `hint` (with Task tool available, `truncate.ts:130`):
```
The tool call succeeded but the output was truncated. Full output saved to: ${file}
Use the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.
```
(without Task tool, `truncate.ts:131`):
```
The tool call succeeded but the output was truncated. Full output saved to: ${file}
Use Grep to search the full content or Read with offset/limit to view specific sections.
```
Tail direction puts the `...N unit truncated...` + hint BEFORE the preview (`truncate.ts:137`).

Separate compaction-only truncation (`message-v2.ts:54`): `${text.slice(0,maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`.

> Note: argent device-control tool outputs (describe JSON, screenshots) are small and rarely hit the 2000-line /
> 50 KB cap; the truncation marker is unlikely to appear in argent trajectories. The media re-injection (§5.3) is
> the junk that actually shows up.

### 5.5 system-reminder wrappers

- Mid-run user interjection (`session/prompt.ts:1313-1320`), wraps the new user text:
  ```
  <system-reminder>
  The user sent the following message:
  ${text}

  Please address this message and continue with your tasks.
  </system-reminder>
  ```
- Read-tool loaded context (`tool/read.ts:356`): `\n\n<system-reminder>\n${loaded}\n</system-reminder>` appended to read output.
- The base prompt (default.txt) tells the model these tags "contain useful information … NOT part of the user's provided input or the tool result."

### 5.6 Other empty-output placeholders (built-in tools, not argent)

- `(no output)` — empty bash/shell output (`tool/shell/shell.ts:586`, `packages/core/src/tool/bash.ts:55`).
- `No files found` (grep), `(Results are truncated: …)` (glob `glob.ts:60`), `(Results truncated. …)` (grep `grep.ts:98`).
- There is **NO** `"Tool ran without output"` and **NO** `"[tool: …]"` prefix anywhere — those don't exist.

---

## 6. Other junk appended to turns

- **`MAX_STEPS` assistant message:** on the final allowed step, an extra `{ role:"assistant", content: MAX_STEPS }`
  is appended to messages (`prompt.ts:1343`), where `MAX_STEPS` = `session/prompt/max-steps.txt` (15 lines).
- **Plan-mode reminders:** `session/reminders.ts` pushes synthetic text parts from `prompt/plan.txt`,
  `prompt/build-switch.txt`, `prompt/plan-mode.txt` (each wrapped in `<system-reminder>`), only in plan mode.
- **Structured-output system addendum:** `STRUCTURED_OUTPUT_SYSTEM_PROMPT` appended to system when the turn
  requests `json_schema` (`prompt.ts:1335`).
- None of these fire for a normal argent device-control turn (build/primary agent, no plan mode, no structured
  output) — except `MAX_STEPS` on the very last step.

---

## 7. Concrete end-to-end request/response examples

### 7.1 Request (default agent, ollama `silver:e4b`, one argent tool exposed)

```json
{
  "model": "silver:e4b",
  "messages": [
    {
      "role": "system",
      "content": "You are opencode, an interactive CLI tool that helps users with software engineering tasks. ...<full default.txt>...\nYou are powered by the model named silver:e4b. The exact model ID is ollama/silver:e4b\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: /Users/you/dev/app\n  Workspace root folder: /Users/you/dev/app\n  Is directory a git repo: yes\n  Platform: darwin\n  Today's date: Tue Jun 23 2026\n</env>\n<AGENTS.md instructions>\n<skills blurb>"
    },
    { "role": "user", "content": "Tap the Login button" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "argent_describe",
        "description": "<argent describe description>",
        "parameters": { "type": "object", "properties": { /* … */ }, "additionalProperties": false }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "argent_gesture-tap",
        "description": "<argent gesture-tap description>",
        "parameters": {
          "type": "object",
          "properties": {
            "device_id": { "type": "string" },
            "x": { "type": "number" },
            "y": { "type": "number" }
          },
          "additionalProperties": false
        }
      }
    }
  ],
  "stream": true
}
```

(With the custom `argentbench` agent, `messages[0].content` starts with the argentbench body instead of
default.txt; env/AGENTS/skills still follow.)

### 7.2 Assistant response (tool call)

```json
{
  "role": "assistant",
  "content": "",
  "tool_calls": [
    {
      "id": "call_9f2a",
      "type": "function",
      "function": { "name": "argent_gesture-tap", "arguments": "{\"device_id\":\"ABC-123\",\"x\":0.5,\"y\":0.82}" }
    }
  ]
}
```

### 7.3 Tool result fed back (text output)

```json
{ "role": "tool", "tool_call_id": "call_9f2a", "content": "{\"ok\":true,\"screen\":\"…\"}" }
```

### 7.4 Tool result that returned a SCREENSHOT, ollama (text-only) model

Because ollama is not in `supportsMediaInToolResult` and (assume) has no image input capability, the wire
becomes: a `role:"tool"` message with the textual part, an assistant step boundary, then a synthetic
`role:"user"` message carrying the media — which `unsupportedParts` rewrites to the error text:

```json
{ "role": "tool", "tool_call_id": "call_9f2a", "content": "<text portion of the tool result, if any>" }
```
```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "Attached media from tool result:" },
    { "type": "text", "text": "ERROR: Cannot read image (this model does not support image input). Inform the user." }
  ]
}
```

(If the model DID declare image input, the second part would instead be the actual image
`{ "type":"image_url"/"image", … }` rather than the ERROR text.)

---

## 8. Live-capture method (validate the above against a real request)

OpenCode's openai-compatible provider just POSTs to `options.baseURL`. To capture the exact bytes, point the
provider at a logging proxy instead of ollama directly:

1. Run any request logger on a local port, e.g. `mitmproxy`, or a tiny node/express that logs the body and
   forwards to `http://localhost:11434/v1`, or `socat`/`ngrep` on port 11434.
2. In `~/.config/opencode/opencode.json`, set the ollama provider `options.baseURL` to the logger, e.g.:
   ```jsonc
   "provider": {
     "ollama": {
       "npm": "@ai-sdk/openai-compatible",
       "options": { "baseURL": "http://localhost:8080/v1" },   // logger → forwards to 11434
       "models": { "silver:e4b": { "name": "silver:e4b" } }
     }
   }
   ```
3. Run a turn: `opencode run --model ollama/silver:e4b "Tap the Login button"` (or the TUI). Capture the POST to
   `/v1/chat/completions`. The body is the ground-truth `messages[]` + `tools[]`.
4. Optional: set `OPENCODE_LOG_LEVEL` / debug logging, but the proxy body is the authoritative wire format.

Use this to confirm: system message count (1), the exact joined system string, the `argent_<tool>` names, the
`additionalProperties:false` schemas, and the tool-result framing.

---

## 9. Notes / surprises

- **Ollama media handling is the big gotcha:** a tool returning a screenshot does NOT reach a text-only ollama
  model as an image. It is re-injected as a synthetic user message `Attached media from tool result:` and then
  the image part is REPLACED by `ERROR: Cannot read image (this model does not support image input). Inform the
  user.` Training data for ollama device-control should therefore render screenshot-returning tools as that
  user-message + error-text pair, never as an image — unless the model's `capabilities.input.image` is true.
- **One system message, fully joined** with `\n` (default.txt + env + AGENTS + skills) — not multiple system
  messages, not the SDK `system:` param.
- **Namespacing keeps dashes:** `argent_gesture-tap`, NOT `argent_gesture_tap`. Separator is `_`, but the tool's
  own dashes survive `sanitize`.
- **No tool-call-ID prefixing** by OpenCode for ollama; the model's own emitted IDs are used and echoed.
- The default-prompt selector keys on `model.api.id` substrings; ollama names like `silver:e4b` fall through to
  `default.txt`. If you ever name an ollama model `…kimi…`/`…trinity…`/with `gpt`/`gemini-`/`claude`, a
  DIFFERENT base prompt would be selected — keep model names clear of those substrings to stay on default.txt.
```
