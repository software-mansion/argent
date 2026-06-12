# native-devtools-vega

> **Staging directory.** Vega (Fire TV) control is provided by **`vega-fast-cli`**, a standalone
> CLI with its own repo: **[software-mansion-labs/vega-fast-cli](https://github.com/software-mansion-labs/vega-fast-cli)**
> (host binary that discovers the VVD, deploys + starts an embedded on-device server, and runs
> the command). argent **shells out** to it.

This directory only stages the downloaded per-platform host binaries for the build:

```
packages/native-devtools-vega/bin/<platform>/vega-fast-cli   # gitignored, fetched at pack time
```

- **Fetch:** [`scripts/download-vega-fast-cli.sh`](../../scripts/download-vega-fast-cli.sh)
  downloads the per-platform binaries (`vega-fast-cli-macos` → `darwin`, `vega-fast-cli-linux`
  → `linux`) from the release repo and sha256-verifies them (authenticated `gh`; the repo is
  private).
- **Bundle:** [`bundle-tools.cjs`](../argent/scripts/bundle-tools.cjs) copies them to
  `packages/argent/bin/<platform>/vega-fast-cli` — the same per-platform layout as
  `simulator-server`.
- **Resolve + run:** [`utils/vega-fast-cli.ts`](../tool-server/src/utils/vega-fast-cli.ts)
  locates `bin/<process.platform>/vega-fast-cli` (or `ARGENT_VEGA_FAST_CLI_BIN`) and the
  `remote` / `keyboard` / `describe` tools `execFile` it.

The on-device server source, the host CLI source, and the build/release pipeline all live in
the `vega-fast-cli` repo. Nothing Vega-specific is built from this monorepo anymore.
