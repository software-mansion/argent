# Windows support

argent's Windows port is **code-complete but binary-blocked**. The whole
toolchain (CLI, MCP server, tool-server, IDE adapters, build pipeline,
unit tests) runs on Windows; only the simulator-server binary is missing,
and that's an upstream dependency.

iOS support is fundamentally mac-only (DYLD_INSERT_LIBRARIES, xcrun, simctl,
dylib injection) and that constraint is reflected in the architecture: every
iOS-only blueprint guards its `factory()` with `device.platform === "ios"`
and the iOS native devtools (`libNativeDevtoolsIos.dylib`,
`libKeyboardPatch.dylib`, `ax-service`) are skipped on non-mac packing
hosts entirely. So Windows is **Android-only by design** — but it's also
**Android-not-yet** because of the simulator-server gap below.

## Why @swmansion/argent doesn't yet boot Android emulators on Windows

`simulator-server` is a Rust binary that controls iOS simulators _and_
Android emulators via gRPC. The upstream
[simulator-server-releases](https://github.com/software-mansion-labs/simulator-server-releases)
repo's `radon-main` tag publishes four assets:

| Asset                           | Has streaming surface? | Used by argent?      |
| ------------------------------- | ---------------------- | -------------------- |
| `simulator-server-argent-macos` | **No** (stripped)      | ✓ shipped on macOS   |
| `simulator-server-macos`        | Yes (vanilla)          | ✗                    |
| `simulator-server-linux`        | Yes (vanilla)          | ✗ (would-be Linux)   |
| `simulator-server-windows.exe`  | Yes (vanilla)          | ✗ (would-be Windows) |

argent ships only the macOS `-argent-` variant — the streaming surface
(`stream_ready` protocol message + WebRTC/H264 codec endpoints) is
deliberately removed in that build. Shipping the vanilla Windows / Linux
binaries inside `@swmansion/argent` would expose a feature the macOS
build deliberately suppresses; that's an IP / feature-parity issue, not
just a packaging detail.

**Unblock**: the radon team needs to publish
`simulator-server-argent-windows.exe` and `simulator-server-argent-linux`
in the same `radon-main` release. The moment those assets exist, two
edits flip Windows / Linux on:

1. `scripts/download-simulator-server.cjs` — add the new asset names to
   the `ASSETS` list.
2. `packages/argent/scripts/bundle-tools.cjs` — add the new filenames to
   `SIMULATOR_SERVER_BINARIES`.

The runtime resolver in `@argent/native-devtools-ios/src/index.ts`
already branches on `process.platform` and looks for `simulator-server.exe`
/ `simulator-server-linux`. The `argent-simulator-server` Node wrapper
(`packages/argent/scripts/argent-simulator-server-wrapper.cjs`) does the
same.

## What ships in the npm package today

`npm run build -w @swmansion/argent` currently packs one simulator-server
binary under `bin/`:

| File               | Targets                             |
| ------------------ | ----------------------------------- |
| `simulator-server` | macOS (universal) — argent-stripped |

On Windows / Linux, `simulatorServerBinaryPath()` throws **"binary not
found"** — the correct fail-closed behavior until the upstream
argent-stripped variants exist. macOS-only artifacts (`*.dylib`,
`ax-service`) likewise ship only when the packing host is macOS.

## Running argent on Windows

### Prerequisites

| Tool           | Why                                                                  |
| -------------- | -------------------------------------------------------------------- |
| Node.js 20+    | `argent` itself                                                      |
| Android SDK    | `adb`, `emulator`, plus a `system-images;android-NN;...` for the AVD |
| `ANDROID_HOME` | Pointed at the SDK root — argent's Android-binary resolver checks it |

`ANDROID_HOME/platform-tools` and `ANDROID_HOME/emulator` need to be on PATH,
or the resolver will fall back to `$ANDROID_HOME` lookups directly.

### Install

```powershell
npm install -g @swmansion/argent
argent init
```

`argent init` writes MCP configs into the right Windows paths for each IDE:

- Cursor → `%USERPROFILE%\.cursor\mcp.json`
- Claude Code → `%USERPROFILE%\.claude.json`
- Windsurf → `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
- Zed → `%APPDATA%\Zed\settings.json` _(Windows uses AppData, not `~/.config`)_
- Gemini → `%USERPROFILE%\.gemini\settings.json`
- Codex → `%USERPROFILE%\.codex\config.toml`
- OpenCode → `%USERPROFILE%\.config\opencode\opencode.json`

## Verifying changes

### CI: GitHub Actions

`.github/workflows/windows-e2e.yml` runs on every push to
`feat/windows-support`. It has two jobs:

1. **`windows-build-and-cli`** — fast (≈2 min) — installs deps, builds the
   workspace, runs unit tests, packs `@swmansion/argent`, **asserts the
   bundle does NOT contain `simulator-server.exe`** (regression guard
   against accidentally re-shipping the vanilla Windows binary), proves
   the resolver fail-closes on Windows, and smokes the CLI dispatcher.
2. **`windows-android-e2e`** — disabled (`if: false`). Re-enable when
   both blockers clear: (a) upstream publishes
   `simulator-server-argent-windows.exe`, and (b) we have a Windows host
   that boots Android emulators reliably. Hosted `windows-latest` runners
   stall Android-34 graphics init past 20 minutes even with WHPX, so they
   are not a viable Android emulator E2E target. The
   `scripts/windows-e2e.cjs` driver script is still maintained and is the
   right way to validate the path against a local UTM/Parallels VM once
   the binary lands.

### Local VM (manual)

Once upstream argent-windows publishes, this is the loop:

1. **UTM** (free, QEMU-based; works on Apple Silicon)

   ```bash
   brew install --cask utm
   ```

   Download a Windows 11 ARM64 ISO from Microsoft, create a VM in UTM, and
   inside Windows install Node.js 20, Android Studio (for the SDK + emulator),
   and `gh`. Mount the argent worktree as a shared folder, then:

   ```powershell
   npm ci
   npm install @rollup/rollup-win32-x64-msvc --no-save
   node scripts/download-simulator-server.cjs
   npm run build
   npm run build -w @swmansion/argent
   node scripts/windows-e2e.cjs
   ```

2. **Parallels Desktop / VMware Fusion** — paid (Parallels) or free for
   personal use (Fusion). Faster than UTM on Apple Silicon for x86 Windows
   thanks to better hypervisor integration. Same in-VM steps.

Until the binary lands, the local loop terminates at "Bundle missing the
Windows simulator-server" — that's the expected failure mode.

## Known gaps

- **Windows simulator-server is not yet bundled.** See the section above:
  upstream `radon-main` only publishes `simulator-server-argent-macos`.
  When the Windows / Linux argent variants land, the two-line edit
  documented above flips them on.
- The `argent-private` dylibs (iOS-only) are not built or downloaded on
  Windows. Any tool dispatched to an iOS device on a Windows host fails fast
  with an "iOS-only" `Error` from the blueprint factory — there is no silent
  "unsupported" mode.
- `argent build:native` (the script that builds the iOS dylibs from
  `argent-private` source) requires Xcode. It still uses bash directly via
  `bash scripts/build.sh` — Windows users never need to run it.
- Hermes (`~/.hermes/config.yaml`) is documented as WSL2-only; argent writes
  the same path on native Windows, but Hermes won't read it there.
