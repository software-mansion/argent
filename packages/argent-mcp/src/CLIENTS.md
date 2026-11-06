# MCP client-specific behaviour

The Argent MCP server sends one tool list and one set of tool results to every
client. A few paths then branch on the MCP handshake `clientInfo.name`
(`Server.getClientVersion()?.name`). Matching is case-insensitive and
whitespace-trimmed; patterns are prefix matches (`/^claude-code\b/`, and so on).

An unnamed or unrecognized client always gets the **default** column below.
That is the safe choice: keep more information rather than drop it.

Source of truth for the lists themselves:

| Behaviour           | Module                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| Screenshot form     | `client-images.ts`                                                      |
| Schema keyword copy | `keyword-facts.ts`                                                      |
| Telemetry slug      | `@argent/telemetry` → `ai-identity.ts` (forwarded from `mcp-server.ts`) |

Re-check a harness after a major release with `scripts/harness-check/`.

## Screenshot form (`ScreenshotForm`)

How a PNG reaches the model. Rendered by `screenshotBlocks` in `content.ts`.

| Form                           | What the client receives                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| **`image-and-path` (default)** | Image block(s), then `Saved: <path>`.                                               |
| `image`                        | Image block(s) only.                                                                |
| `path`                         | Path note only (no image). Tells the model to open the PNG with its file-read tool. |

`toMcpContent(..., form)` also defaults the `form` argument to `"image-and-path"` when
the caller omits it.

Two pickers, both keyed off `clientInfo.name`:

### Explicit `screenshot` tool — `screenshotForm`

Used when the agent called `screenshot` (or any other `outputHint: "image"` result
routed through the normal tool path in `mcp-server.ts`).

| Client                       | Form                 |
| ---------------------------- | -------------------- |
| `Q DEV CLI` (Kiro CLI v1/v2) | `path`               |
| **Everyone else (default)**  | **`image-and-path`** |

`screenshotForm` never returns `image`. An agent-requested shot keeps the path so
the model can reopen the file later.

### Auto-screenshot after an interaction — `autoScreenshotForm`

Used when Argent appends "--- Screen after action ---" after a gesture or similar
tool (`captureScreenshotBlocks` in `mcp-server.ts`).

| Client                                                                                                                      | Form                 | Why                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| Claude Code, Codex, Cursor (`Cursor`, `cursor-vscode`, …), opencode, Gemini CLI, Zed, VS Code, `copilot-cli`, Kiro (`kiro`) | `image`              | The model already sees the PNG; `Saved:` adds nothing.                 |
| `Q DEV CLI`                                                                                                                 | `path`               | The client would ship ~80k tokens of base64 text the model cannot see. |
| **Everyone else (default)**                                                                                                 | **`image-and-path`** | Unknown clients keep both.                                             |

`includeImageInContext: false` on the tool args overrides every form and returns
only `Saved: <path>`.

## Schema keyword facts — `showsSchemaKeywords` / `withKeywordFacts`

Some clients strip JSON Schema keywords (`default`, `minimum`, `maximum`, …) before
the model reads the tool schema. For those, Argent copies the missing facts into
each property's `description` at `tools/list` time.

| Client                                                                  | Keywords reach the model? | Argent copies facts into descriptions? |
| ----------------------------------------------------------------------- | ------------------------- | -------------------------------------- |
| Claude Code, Gemini CLI, Zed, Kiro (`kiro`), `Q DEV CLI`, `copilot-cli` | Yes (checked)             | No                                     |
| **Everyone else (default), including Codex, opencode, Cursor, unknown** | Not reliably              | **Yes**                                |

The keywords stay on the schema either way; clients that validate with them still
see them. Details of what is copied (and what is left out on purpose) live in
`keyword-facts.ts`.

## Telemetry — `X-Argent-AI-Client`

Every tool-server request carries a coarse slug derived from `clientInfo.name`
(never the raw string). Unrecognized names become `other`. Mapping lives in
`packages/telemetry/src/ai-identity.ts`; it does not change tool results or
schemas.

## Quick matrix

Handshake names are the ones each client has been observed to send (or ships in
source). Patterns accept a trailing version suffix.

| `clientInfo.name` (examples)      | Explicit screenshot | Auto-screenshot    | Keyword facts copied? |
| --------------------------------- | ------------------- | ------------------ | --------------------- |
| `claude-code`                     | image-and-path      | image              | no                    |
| `codex-mcp-client`                | image-and-path      | image              | yes                   |
| `Cursor`, `cursor-vscode`         | image-and-path      | image              | yes                   |
| `opencode`                        | image-and-path      | image              | yes                   |
| `gemini-cli-mcp-client`           | image-and-path      | image              | no                    |
| `Zed`                             | image-and-path      | image              | no                    |
| `Visual Studio Code` (+ Insiders) | image-and-path      | image              | yes                   |
| `copilot-cli`                     | image-and-path      | image              | no                    |
| `kiro` (IDE / CLI v3)             | image-and-path      | image              | no                    |
| `Q DEV CLI` (Kiro CLI v1/v2)      | path                | path               | no                    |
| unnamed / unknown                 | **image-and-path**  | **image-and-path** | **yes**               |
