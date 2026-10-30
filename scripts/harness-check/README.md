# Harness check

Runs real coding-agent CLIs (harnesses) against the Argent MCP server of your checkout and
shows what each harness's model actually gets from Argent: which tools, which facts from
the tool schemas, and whether the server instructions arrive.

Run it by hand when you change tool schemas, tool descriptions, the server instructions or
`packages/argent-mcp/src/keyword-facts.ts`, or when a harness ships a major release. It is
not part of CI: two of the harnesses need a signed-in account.

## Why

Argent sends one `tools/list` to every client, but each harness rewrites it before its
model sees it. Codex, for example, deletes `default`, `minimum` and `maximum`, so a value
that only such a keyword states never reaches its model. Argent copies those values into
the param descriptions for such clients (`keyword-facts.ts`). This check shows whether that
works, and whether anything is lost or repeated.

## How it works

```
harness CLI ──starts──▶ Argent MCP server (server.mjs: your checkout's build)
     │
     └──request to its model──▶ local stand-in (model-stub.mjs): saves it, answers "ok"
                                Claude Code and Kiro CLI: their real backend; the request
                                is saved on the way out
```

1. `server.mjs --reference` reads the server's tool list as it is before any
   client-specific text, plus the instructions. This is the reference.
2. Each harness runs once, headless, with a scratch HOME. It starts the Argent server
   itself, as it would for a user, and sends its requests to the model. Every request is
   saved.
3. `analyze.mjs` reads the saved request with the most Argent tools in it:
   - opencode first sends a request without tools, for the session title, so the check
     reads its second one;
   - Codex gives its model only a `tool_search` tool at first. The stand-in answers the
     first request with a `tool_search` call that matches every Argent tool, so the
     schemas arrive in the tool result of Codex's second request.

   For every fact a schema keyword states in the reference (a default, a range, a length
   or item limit), it looks for the places the model can read it:
   - the keyword itself;
   - Argent's own description text;
   - a sentence Argent added;
   - text the harness added.

   No place means the fact is lost. Two or more mean the model reads it twice.

For Codex, Gemini CLI and opencode, no model takes part, so the same setup always gives
the same request. Claude Code and Kiro CLI get a real model reply, but only after their
request has been saved.

## Setup

- **Node 20 or newer, and npm.** Tried on macOS only.
- **A built checkout:** `npm ci && npm run build`. The check runs the server from `dist/`.
- **Network access on the first run.** Codex 0.164.0, opencode 1.19.4 and Gemini CLI 0.65.0
  are installed into `node_modules/.cache/argent-harness-check/` (about 600 MB). They
  need no account: their model requests go to the local stand-in.
- **Optional, for `--with claude`:** Claude Code installed and signed in (`claude` on
  PATH). Each run sends one short request to Anthropic: about $0.10 by Claude Code's own
  count. `--claude-all-tools` adds a run that loads every tool, for about $0.50.
- **Optional, for `--with kiro`:** Kiro CLI installed and signed in (`kiro-cli` on PATH).
  One short request goes to Kiro's backend and uses your Kiro credits.

The check writes nothing to `~/.argent` and sends no Argent telemetry. Each harness runs
with its own scratch HOME, except Claude Code and Kiro CLI, which need your account. Those
two get Argent from a config file the check writes (`--mcp-config` for Claude Code, a
`.kiro/settings/mcp.json` in the check's working folder for Kiro), not from your settings.
Their saved requests contain whatever else they send their model from your HOME (for
Claude Code, your `CLAUDE.md`), so check the results folder before you share it.

## Usage

```bash
npm run harness-check                                   # Codex, opencode (3 providers), Gemini CLI
npm run harness-check -- --with claude,kiro             # also Claude Code and Kiro CLI
npm run harness-check -- --with claude --claude-all-tools
npm run harness-check -- --only codex                   # one harness
npm run harness-check -- --help
```

A run takes about 30 seconds after the first install. Results go to a new folder in the
temp directory, or to `--out <dir>`.

### Comparing two versions, e.g. `main` and your branch

The server comes from `--repo`, so you can check another checkout without switching
branches:

```bash
git worktree add ../argent-main main
(cd ../argent-main && npm ci && npm run build)

npm run harness-check -- --repo ../argent-main --with claude,kiro --out /tmp/hc-main
npm run harness-check -- --with claude,kiro --compare /tmp/hc-main
```

The second command adds a table of what changed in each harness's request, plus the
sentences added to or removed from the server instructions.

## Reading the results

```
Harness                     Version  Sent as           Tools  Facts lost  Repeated by Argent  Instructions  Input tokens  Result
Claude Code                 2.1.312  claude-code       12/77  0 of 30     0                   yes           36469         OK
Codex                       0.164.0  codex-mcp-client  77/77  0 of 140    0                   yes           -             OK
opencode (Anthropic model)  1.19.4   opencode          77/77  0 of 140    89                  yes           -             REPEATS 89
Kiro CLI                    2.34.2   Q DEV CLI         77/77  0 of 140    0                   no            -             OK
```

- **Sent as:** the name the harness gives in the MCP handshake. The server decides by this
  name whether to add text (`showsSchemaKeywords` in `keyword-facts.ts`).
- **Tools:** Argent tools whose schema is in the request. Claude Code loads most tools only
  when needed, so its first request has about a dozen.
- **Facts lost:** facts the model can't read anywhere in the request. This should be 0.
- **Repeated by Argent:** facts the model reads twice because Argent added a sentence
  although the harness kept the keyword. This should be 0, except for opencode with an
  Anthropic model: the server can't tell which model opencode uses, so it adds text for
  every opencode model.
- **Instructions:** whether the server instructions are in the request. Kiro CLI never
  sends them; that is Kiro's behaviour, not a failure.
- **Input tokens:** the whole request as counted by Anthropic's API, for Claude Code only.
  The other harnesses talk to the local stand-in, so nothing counts their tokens. With
  `--compare`, the change per harness is shown. Every check runs the harnesses in the
  same folder (`argent-harness-check-workspace/` in the temp directory), because Claude
  Code puts its working directory into the prompt; that keeps two checks comparable.
  Claude Code also runs with your own HOME, so the count includes your own setup (your
  `CLAUDE.md`, for example). Only the change between two checks on one machine says
  something about Argent.
- **Result:** one of the following.
  - **OK**
  - **LOSES n**
  - **REPEATS n**
  - **UNEXPECTED TEXT:** Argent added text that states no keyword of its param, which
    points to a bug in `keyword-facts.ts`.
  - **FAILED:** the harness did not run. Read `runs/<harness>/output.txt`.

The results folder holds:

- `report.md`: the table, plus every lost or repeated fact by name, and the param
  descriptions the harness changed itself (Claude Code, for example, turns "…" into "...").
- `results.json`: the same data, used by `--compare`.
- `reference.json`: what the server serves.
- `runs/<harness>/`: per harness:
  - `requests/`: the saved requests;
  - `output.txt`: the harness output;
  - `server.log`: the client name in each handshake;
  - `server-home/mcp-calls.log`: the server's own log, with `keywordFacts` per tool listing.

## Limits

- **Not covered:**
  - GUI apps (Zed, VS Code, Kiro IDE) have to be driven by hand.
  - Cursor and Devin send to their own cloud and can't be pointed at a local endpoint.
  - Hermes is not included.
- **One request per harness is checked**, the one with the most Argent tools (see
  [How it works](#how-it-works)). A harness that loads tools on demand in a way the check
  doesn't script (Kiro IDE, Hermes) sends schemas later, inside a tool result, and is not
  covered.
- **The text matching is a heuristic.** If a description states a value in unusual words,
  the check may count it as lost or miss a repeat. In that case, read the param in
  `report.md` and the saved request.
- **One check at a time.** Two checks running at once on one machine share that folder.
- **The pinned versions get old.** To check a newer release, change `PINS` in
  `harnesses.mjs`. The request formats change between releases, so a new version can need
  a fix in `analyze.mjs` (where it finds the tools in a request) or `model-stub.mjs`.

## Troubleshooting

- **FAILED, "no request recorded":**
  - The harness didn't reach the stand-in or its backend. Check `runs/<harness>/output.txt`.
  - For Claude Code and Kiro CLI, make sure you're signed in: run `claude` or `kiro-cli`
    once by hand.
- **FAILED, "the Argent server was never started":** the harness ran but didn't start the
  server. Check that the checkout is built.
- **NO ARGENT TOOLS IN REQUEST:** the server started but no tool reached the request. Look
  for errors in `output.txt` and `server-home/mcp-calls.log`.
