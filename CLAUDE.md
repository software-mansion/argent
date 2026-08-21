# argent

## Documentation

The official documentation site lives in `packages/docs/`. It is published to
docs.swmansion.com/argent. See `packages/docs/CLAUDE.md` for the writing style, page
front matter and build checks.

**Always check whether a change needs a documentation update before opening a pull
request.** Treat the docs as part of the change, not as follow-up work.

Ask this for every pull request:

- Does the change add, rename or remove an MCP tool, or change its parameters, defaults
  or behaviour? Update `packages/docs/docs/reference/tools.mdx`, and the matching page in
  `packages/docs/docs/features/` if the user facing capability changed.
- Does the change touch the CLI, its commands or flags? Update
  `packages/docs/docs/reference/cli.mdx`.
- Does the change touch configuration keys or defaults? Update
  `packages/docs/docs/reference/configuration.mdx`.
- Does the change touch flow files? Update `packages/docs/docs/reference/flow-yaml.mdx`
  and `packages/docs/docs/features/flows.mdx`.
- Does the change touch installation, supported platforms, editor setup or telemetry?
  Update the matching page in `packages/docs/docs/fundamentals/` or
  `packages/docs/docs/reference/`.
- Does the change add a whole new capability? Add a `features/` page for the concept and
  a `reference/` entry for the details.

If the change needs no documentation update, say so explicitly in the pull request
description instead of staying silent about it.

After editing docs, run `npx docusaurus build` and `npm run format` in `packages/docs/`.
