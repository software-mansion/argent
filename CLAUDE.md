# argent

## Documentation

The docs site lives in `packages/docs/` and is published to docs.swmansion.com/argent.
See `packages/docs/CLAUDE.md` for writing style, front matter and checks.

Update the docs in the same pull request as the change:

- MCP tools, CLI, config keys, flow files -> the matching page in
  `packages/docs/docs/reference/`, plus `docs/features/` if the user facing capability
  changed.
- Install, platforms, editor setup, telemetry -> `packages/docs/docs/fundamentals/`.
- A new capability -> a `features/` page and a `reference/` entry.

If no docs update is needed, say so in the pull request description.

After editing docs, run `npx docusaurus build` in `packages/docs/` and `npm run format` from the
repo root.
