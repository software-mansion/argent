# Full Argent E2E harness

A release-gating end-to-end test that starts from **nothing but a
`swmansion-argent-*.tgz` bundle** and exercises the whole product: the install
flow, every CLI command, all 70 tools' argument validation, and a happy-path run
of every tool that applies against real devices.

Run it on the real Linux box and the real Mac before a release.

## Quick start

```bash
# from the repo root, with a swmansion-argent-*.tgz present there:
bash scripts/e2e-full/run-e2e.sh

# a subset of phases:
bash scripts/e2e-full/run-e2e.sh --phase install,introspection,validation

# offline core only, driving the unpacked bundle (no npm install, fast):
bash scripts/e2e-full/run-e2e.sh --skip-install --phase introspection,validation
```

A markdown report is written to `scripts/e2e-full/results/report-<ts>.md` and the
raw per-case log to `results/e2e-<ts>.jsonl`. The process exits non-zero if any
hard assertion failed (skips do not fail the run).

## What it does (phases)

| phase | needs | covers |
|---|---|---|
| `install` | npm + network | `npm i -g <tgz>`, bundled binaries, `init` (global + `--local`), `update`, `uninstall`, telemetry, MCP-config generation |
| `introspection` | — | `--version/--help`, `tools`, `tools describe` for **all 70** tools, feature flags, `server start/status/logs/stop`, `link/unlink` |
| `validation` | — | for every tool: missing-required / bad-enum / bad-type rejection (deterministic, no hardware) |
| `android` | Android emulator | happy-path of every touch/gesture/screenshot/app-lifecycle tool |
| `chromium` | Electron (bundled optional dep) + a display | boots a generated Electron app; drives CDP tools (scroll/drag/tabs/cookies/storage) |
| `rn` | `~/dev/bluesky` + Android device | debugger + react/native profiler + network chain against the real Bluesky app |

Tiers auto-skip (with a recorded reason) when their prerequisites are missing, so
a partial run still produces a meaningful report. iOS / tvOS / Vega tiers are
intentionally out of scope.

## Isolation

Everything runs under a throwaway `HOME` and npm prefix (`$(mktemp -d)`), so the
real machine's `~/.argent`, editor MCP configs, and global packages are never
touched — safe to run on a shared box. Add `--keep` to inspect the sandbox after.

## Providing a device

The device tiers need a booted device. Two ways:

- **Inject** an already-booted one (recommended on shared/CI machines):
  `--android-serial emulator-5554` (the harness attaches, doesn't boot/teardown it).
- **Let the harness boot it**: `--android-avd Pixel_9a` (uses `boot-device`).

The Chromium tier needs no device — it generates and boots its own Electron app
(requires `DISPLAY`, or `xvfb-run` on a headless Linux box).

## RN (Bluesky) tier

```bash
E2E_RN_DIR=~/dev/bluesky E2E_RN_PKG=xyz.blueskyweb.app \
  bash scripts/e2e-full/run-e2e.sh --phase rn --android-serial <serial>
```

Assumes the Bluesky dev-client is already built and installed on the device
(`E2E_RN_PREBUILT`, the default). Pass `E2E_RN_BUILD=1` to let it run
`expo run:android` first (slow). It starts Metro itself and tears it down.

## Flags

```
--tgz PATH             tarball to test (default: newest swmansion-argent-*.tgz at repo root)
--phase a,b,c          subset of: install introspection validation android chromium rn
--skip-install         drive the unpacked bundle directly (offline phases only; skips `install`)
--system               install to the REAL global prefix (dedicated release machine only)
--android-serial S     use an already-booted Android device
--android-avd NAME     boot this AVD via boot-device
--keep                 leave the sandbox dir for inspection
```

## Layout

```
run-e2e.sh          orchestrator: env setup, phase dispatch, report, exit code
lib/common.sh       logging, argent_cli/run_tool, assert_* helpers, server + screenshot helpers
lib/discover-tools.sh   parses `argent tools describe` into per-tool arg models
lib/report.py       JSONL -> markdown (per-phase + per-tool coverage matrix + failures)
phases/*.sh         one run_phase() per phase
results/            generated JSONL + report (gitignored)
```
