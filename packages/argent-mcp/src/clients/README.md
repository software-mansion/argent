# MCP client profiles

The Argent MCP server sends one tool list and one set of tool results to every
client. Some clients change them before their model reads them. For those clients,
the server changes a few things itself. It identifies the client by the MCP
handshake `clientInfo.name` (`Server.getClientVersion()?.name`).

`profiles.ts` is the one source of truth. `KNOWN_CLIENTS` has one row per client,
and each row gives:

- `names`: prefix patterns, tested against the trimmed, lower-cased name.
- `seen`: the handshake names the client was seen to send.
- `screenshot`, `autoScreenshot`, `keywordFacts`: what the server does for it.
- `telemetry`: the slug `@argent/telemetry` records for those names.

An unnamed or unknown client gets `DEFAULT_PROFILE`. The default keeps more
information rather than less.

`mcp-server.ts` calls `clientProfile()` and passes the fields on. `content.ts` and
`keyword-facts.ts` do not know any client names.

## Add or change a client

1. Capture the request the client sends to its model: `scripts/harness-check/`, or a
   proxy. Re-check a client after a major release.
2. Add or change its row in `profiles.ts`. Every field is required, so every
   behaviour gets a decision. In the row's comment, say what was checked, on which
   version, and how. The words for how are defined above `KNOWN_CLIENTS`.
3. Put the handshake names you saw in `seen`.
4. Update the matrix below and the expectations in
   `test/client-profiles.test.ts`. The test fails until all three agree.
5. Set `telemetry` to what `canonicalizeAiClient` returns for those names, `other`
   if it returns nothing. To record a new slug, change
   `packages/telemetry/src/ai-identity.ts` first.

## Matrix

`test/client-profiles.test.ts` checks this table against `profiles.ts`.

| `clientInfo.name`                                     | Profile             | `screenshot` tool | Auto-screenshot  | Keyword facts copied | Telemetry slug |
| ----------------------------------------------------- | ------------------- | ----------------- | ---------------- | -------------------- | -------------- |
| `claude-code`                                         | `claude-code`       | `image-and-path`  | `image`          | no                   | `claude_code`  |
| `codex-mcp-client`                                    | `codex`             | `image-and-path`  | `image`          | yes                  | `codex`        |
| `Cursor`, `cursor-vscode`                             | `cursor`            | `image-and-path`  | `image`          | yes                  | `cursor`       |
| `opencode`                                            | `opencode`          | `image-and-path`  | `image`          | yes                  | `opencode`     |
| `gemini-cli-mcp-client`                               | `gemini-cli`        | `image-and-path`  | `image`          | no                   | `gemini`       |
| `Zed`                                                 | `zed`               | `image-and-path`  | `image`          | no                   | `zed`          |
| `Visual Studio Code`, `Visual Studio Code - Insiders` | `vscode`            | `image-and-path`  | `image`          | yes                  | `vscode`       |
| `copilot-cli`                                         | `vscode-agent-host` | `image-and-path`  | `image`          | no                   | `other`        |
| `kiro`                                                | `kiro`              | `image-and-path`  | `image`          | no                   | `other`        |
| `Q DEV CLI`                                           | `kiro-cli-v2`       | `path`            | `path`           | no                   | `other`        |
| unnamed or unknown                                    | `default`           | `image-and-path`  | `image-and-path` | yes                  |                |

## Screenshot form

`ScreenshotForm` in `content.ts` sets how a PNG reaches the model.
`screenshotBlocks` in `content.ts` renders it.

| Form                       | What the client receives                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `image-and-path` (default) | The image blocks, then `Saved: <path>`.                                                      |
| `image`                    | The image blocks only.                                                                       |
| `path`                     | A path note only, with no image. It tells the model to open the PNG with its file-read tool. |

A profile has two forms:

- `screenshot`: a screenshot the agent asked for, with the `screenshot` tool or any
  other `outputHint: "image"` result. It is never `image`, because the agent may want
  to open the file again later.
- `autoScreenshot`: the screenshot the server appends after an interaction
  (`--- Screen after action ---`, `captureScreenshotBlocks` in `mcp-server.ts`).

A client that shows images gets `image` after an interaction, because its model
already sees the PNG. Kiro CLI with the v1 or v2 engine (`Q DEV CLI`) gets `path`
for both. It would send the image to the model as about 80,000 tokens of base64 text.

`includeImageInContext: false` in the tool arguments overrides every form. The
result is `Saved: <path>` only.

## Keyword facts

Some clients remove JSON Schema keywords (`default`, `minimum`, `maximum`, and
others) before the model reads the tool schema. For a profile with `keywordFacts`,
the server copies the missing facts into each property `description` when it
answers `tools/list` (`withKeywordFacts` in `keyword-facts.ts`).

The keywords stay on the schema in both cases, for the clients that validate with
them. A client gets the copy unless every model it was checked with shows the
keywords. A repeated fact costs less than a missing one.

## Telemetry

Every tool-server request carries an `X-Argent-AI-Client` slug. The mapping from
`clientInfo.name` to the slug stays in `packages/telemetry/src/ai-identity.ts`,
because its slug list is also the list of values that telemetry may record. The
`telemetry` field in each row records what that mapping returns, and a test checks
it.

Some names have a telemetry slug but no row here: `code - oss`, `windsurf`,
`github-copilot-developer`, and `rmcp` with `WINDSURF_IDE_TYPE` set. They get the
default profile.
