# Tool definitions

Each folder here defines MCP tools as `ToolDefinition`s (see `@argent/registry`).

## What reaches the agent

Only part of a definition reaches the agent, and each file keeps that part in one place:

- The zod schema: param names and order, `.describe()` text, and keywords such as `default`,
  `minimum` or `enum`, with any sub-schemas it uses. It sits directly above the definition, or
  above the factory function that returns it (`paste` and `shake` keep theirs in `schema.ts`).
- The first keys of the definition, in the order of an MCP `tools/list` entry: `id`,
  `description` and `zodSchema`; then `alwaysLoad` and `searchHint`, which only Claude Code
  reads, and `readOnly`, sent as the `readOnlyHint` annotation; then `hideFromMcp`,
  `featureFlag` and `hideWhen`, which decide whether the tool is listed at all.

The rest of the definition (`interaction`, `capability`, `services`, `execute`, ...) never
reaches the agent. Messages from `.refine()` and thrown errors reach it only when a call fails.

## Seeing what agents receive

```bash
npm run render:agent-context
```

This renders what `@argent/mcp` sends for the current source into
`packages/tool-server/agent-context/` (not committed): one markdown file per tool, one for the
server instructions, and a README that explains how clients pass all of it on to their model.
It runs the real registry, `GET /tools` route and MCP mapping, with every feature flag at its
default. Run it after you change a description, a schema or the server instructions.

- To render with a flag on: `npm run render:agent-context -- --out <dir> --enable <flag>`.
- To review a change: render `main` and your branch into two folders with `--out`, and diff them.
