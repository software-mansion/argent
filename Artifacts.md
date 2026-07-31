# Artifact pipeline audit

Audit of whether every file-producing tool routes its output through the artifact
materializer, and whether every consumer surface materializes what it receives.

Audited at `main` @ `646f726b` (2026-07-31).

**Verdict: every artifact that actually carries file bytes to the client goes through the
materializer.** All file-producing tools register their outputs in the registry-owned
`ArtifactStore` and return `ArtifactHandle`s, and every consumer surface (MCP server, CLI `run`,
CLI `flow`) runs results through `materializeArtifacts`. No broken transport path was found. There
are three places where raw host paths appear in results, all deliberate/informational, plus one
genuine (but by-design-local) gap in the flag-gated Lens tool.

## How the pipeline is wired

- **Store** — `packages/registry/src/artifacts.ts`. `ArtifactStore.register()` mints a UUID handle
  (`__argentArtifact` marker, filename, mime, size, mtime, `hostPath`, optional
  `archive: "tar.gz"` for directory bundles, optional `saveDir` for durable persistence).
- **Injection** — `packages/registry/src/registry.ts:146` puts the store into _every_ tool
  invocation's context (`ctx.artifacts`), so nested/sub-invoked tools (flow steps, run-sequence,
  the MCP auto-screenshot) register into the same store the HTTP route serves. `requireArtifacts()`
  (`packages/tool-server/src/artifacts.ts:43`) throws loudly if a test bypasses the registry —
  there is no silent fallback to raw paths.
- **Transport** — `packages/tool-server/src/artifacts.ts`: `GET /artifacts/:id` streams the file
  (404 unknown, 410 vanished), tar-gzipping directory bundles on demand only for remote clients.
- **Materializer** — `packages/argent-tools-client/src/artifacts.ts:398`. Deep-walks any result,
  and per handle: co-located gate (trust `hostPath` only if size+mtime match) → else authenticated
  download into the temp cache → rewrites the handle to a real local path, or `null` on failure
  (never a dangling server path). Durable artifacts (`saveDir`) go through the client-side
  allowlist, the `recordings.directory` redirect, symlink confinement (`confineToRealBase`),
  exclusive non-clobbering writes, and the 2 GiB size-verified download cap.

## Producer audit — every file-producing tool

| Tool                            | Files produced                   | Through the store?                                                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `screenshot`                    | PNG                              | ✅ All 4 branches register — Chromium (`screenshot/index.ts:154`), tvOS (`:162`), Vega (`:171`), iOS/Android sim-server incl. physical iOS (`:183`). No branch returns the legacy `{url, path}` shape anymore.                                         |
| `screenshot-diff`               | diff + context-diff PNGs         | ✅ Both registered (`screenshot-diff/index.ts:155,159`). Its _inputs_ (baseline/current from the client) cross the reverse boundary via declared `fileInputs` (`:89–113`).                                                                             |
| `screen-recording-stop`         | mp4                              | ✅ Registered with `saveDir: ".argent/recordings"` (`screen-recording-stop.ts:86–91`) → durable client-side persistence, honoring the `recordings.directory` redirect (PR #601).                                                                       |
| `native-profiler-stop`          | .trace/.pftrace bundle + exports | ✅ Every export registered (`native-profiler-stop.ts:65`), trace bundle registered as `archive: "tar.gz"` (`:76`); both live paths (`:113`) and recovered-session paths (`:125`) covered.                                                              |
| `native-profiler-analyze`       | report file                      | ✅ Registered (`native-profiler-analyze.ts:78`), null-safe when analysis produced none.                                                                                                                                                                |
| `react-profiler-analyze`        | raw CPU/commit dumps             | ✅ Registered (`react-profiler-analyze.ts:37,233`).                                                                                                                                                                                                    |
| `flow-execute` (snapshot steps) | baseline/current/diff PNGs       | ✅ All roles registered in `flow-visual.ts` (`:232`, `:265`, `:333`, `:346`, `:353`), including the cropOn variants; host paths deliberately survive the scratch-dir sweep for later materialization (regression-tested in `flow-visual.test.ts:336`). |

Tools that write files but correctly keep them internal (nothing path-shaped escapes to the
client): `react-profiler-stop` (dumps cached server-side as session state, response is stats
only), `profiler-load`/`profiler-*-query`/`profiler-combined-report` (return markdown/text; paths
used server-side only), `boot-device`, `update-argent`, `watermark`, `describe`'s uiautomator
dumps, network log tools (JSON text).

## Consumer audit — everything runs the materializer

- **MCP server** (`packages/argent-mcp/src/mcp-server.ts:299–303`): all three render branches —
  `flowRunToMcpContent`, `screenshotDiffToMcpContent`, generic `toMcpContent` — receive a ctx that
  is always constructed, and each calls `materializeArtifacts` (`content.ts:73,173,373`). The
  auto-screenshot side-channel (`:349`) also materializes. Legacy `{url, path}` rendering survives
  only as a compat fallback for _older tool-servers_, with PNG-signature validation.
- **CLI `argent run`** (`packages/argent-cli/src/run.ts:267`): materializes every result, uses
  materialized image bytes for `--out`, legacy fetch only as fallback.
- **CLI `argent flow run`** (`flow.ts` `exportFailureArtifacts`): materializes exactly the failed
  snapshots' artifacts into `--output`, with `SAFE_ARTIFACT_NAME` + path-escape hardening;
  remaining handles are stringified without fetching.

## Findings (ranked, none transport-breaking)

1. **`propose_variant` (argent-lens) — the only real remote gap.** `variant.previewImage` and
   `variant.filePath` accept _local file paths_ but the tool declares no `fileInputs`, unlike
   `reinstall-app`/`screenshot-diff`/`gather-workspace-data`/flow tools. Under a remote
   `argent link` server, a client-side screenshot path would be unreadable server-side.
   Mitigating: Lens is a local native window by design and flag-gated off by default. If Lens is
   ever meant to work over `argent link`, `previewImage`/`filePath` need `kind: "file"` fileInput
   specs.
2. **`native-profiler-start` and `screen-recording-start` return raw host paths** (`traceFile`,
   `outputFile`). Informational only — the description of `screen-recording-start` explicitly
   says the video is retrieved by `-stop`, and both stop tools register properly. A remote client
   just sees a meaningless-but-harmless server path. Could be dropped from the result surface for
   purity.
3. **Deliberate non-materialization (documented economy, fine):** flow baseline/current handles
   render as `hostPath ?? filename` text without fetching bytes (`content.ts:379–380`; same in
   the CLI) — only a _failed_ step's diff is downloaded and inlined. Correct trade-off, but the
   printed path is a server path for remote clients; printing `filename` unconditionally would be
   marginally cleaner.
4. **Cosmetic:** `profiler-load`'s "no data found" error embeds server host paths in the message
   text (`profiler-load.ts:239–241`). Harmless, mildly confusing over `argent link`.

## Robustness notes (things that are done right and worth keeping)

- Handles that fail to resolve rewrite to `null`, never to a dangling path; a malformed `saveDir`
  degrades to scratch instead of rejecting sibling artifacts (`durableSaveTarget`'s type guard).
- The durable path is defended in depth: client-side `ALLOWED_SAVE_DIRS` allowlist, lexical
  `..`/absolute checks, post-mkdir realpath confinement against pre-planted symlinks, exclusive
  `wx`/`COPYFILE_EXCL` writes with `name (2).ext` collision handling, and size-verified capped
  downloads against a hostile server.
- The contract is regression-tested on both sides: `packages/tool-server/test/artifacts.test.ts`,
  `packages/argent-tools-client/test/artifacts.test.ts`,
  `packages/argent-cli/test/run-artifacts.test.ts`, plus flow-visual's host-path-survival and
  filename-collision tests.

Bottom line: the materializer boundary is sound. The one item worth actually fixing is the missing
`fileInputs` declaration on `propose_variant` if remote Lens is ever on the roadmap; everything
else is polish.
