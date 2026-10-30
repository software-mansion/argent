# Tool definitions

Each folder here defines MCP tools as `ToolDefinition`s (see `@argent/registry`).

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
