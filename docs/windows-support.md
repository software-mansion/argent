# Windows support

argent runs on Windows for **Android emulator** workflows. iOS is fundamentally
mac-only (DYLD_INSERT_LIBRARIES, xcrun, simctl, dylib injection) and that
constraint is reflected in the architecture: every iOS-only blueprint guards
its `factory()` with `device.platform === "ios"` and the iOS native devtools
(`libNativeDevtoolsIos.dylib`, `libKeyboardPatch.dylib`, `ax-service`) are
skipped on non-mac packing hosts entirely.

## What ships in the npm package

`npm run build -w @swmansion/argent` packs three simulator-server binaries
under `bin/`:

| File                     | Targets                                   |
| ------------------------ | ----------------------------------------- |
| `simulator-server`       | macOS (universal) — argent-customized iOS |
| `simulator-server.exe`   | Windows x64 — vanilla upstream, Android   |
| `simulator-server-linux` | Linux x64 — vanilla upstream (future use) |

The runtime resolver in `@argent/native-devtools-ios` picks the right filename
per `process.platform`. macOS-only artifacts (`*.dylib`, `ax-service`) ship
only when the packing host is macOS — `@swmansion/argent` published from
Linux or Windows still works for Android-only consumers.

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
`feat/windows-support` and on `workflow_dispatch`. It has two jobs:

1. **`windows-build-and-cli`** — fast (≈3 min) — installs deps, builds the
   workspace, runs unit tests, packs `@swmansion/argent`, asserts that the
   Windows simulator-server binary is bundled and `--help` exits 0, and
   smokes the CLI dispatcher (`argent --version`, `argent tools`).
2. **`windows-android-e2e`** — slow (≈15 min) — boots a real Android emulator
   on `windows-latest` and runs `scripts/windows-e2e.cjs`, which spawns the
   bundled tool-server, calls `list-devices`, `screenshot`, and
   `stop-all-simulator-servers` against the running emulator. Gated to the
   windows-support branch / manual dispatch so PRs to `main` don't pay the
   boot cost on every push.

To trigger manually:

```bash
gh workflow run windows-e2e.yml --ref feat/windows-support
gh run watch
```

### Local VM (manual)

Useful when iterating on Windows-specific paths and you need a tighter
feedback loop than CI. Two paths from a macOS host:

1. **UTM** (free, QEMU-based; works on Apple Silicon)

   ```bash
   brew install --cask utm
   ```

   Download a Windows 11 ARM64 ISO from Microsoft, create a VM in UTM, and
   inside Windows install Node.js 20, Android Studio (for the SDK + emulator),
   and `gh`. Mount the argent worktree as a shared folder, then run the same
   commands the CI runs:

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

Locally, the heavyweight Android emulator boot is the slow step (~3-5 min
even with hardware acceleration). The `windows-build-and-cli` flow runs in
under a minute and catches most regressions on its own.

## Known gaps

- The `argent-private` dylibs (iOS-only) are not built or downloaded on
  Windows. Any tool dispatched to an iOS device on a Windows host fails fast
  with an "iOS-only" `Error` from the blueprint factory — there is no silent
  "unsupported" mode.
- `argent build:native` (the script that builds the iOS dylibs from
  `argent-private` source) requires Xcode. It still uses bash directly via
  `bash scripts/build.sh` — Windows users never need to run it.
- Hermes (`~/.hermes/config.yaml`) is documented as WSL2-only; argent writes
  the same path on native Windows, but Hermes won't read it there.
