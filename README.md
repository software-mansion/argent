<br/>
<p align="center">
  <a href="https://argent.swmansion.com">
    <img width="1100" height="382" alt="argent-header" src="https://github.com/user-attachments/assets/6cec01d5-da3c-4b6c-97c3-0374a63c213c" />
  </a>
</p>
<br/>

**[Argent](https://argent.swmansion.com)** is an **agentic toolkit** that gives your AI assistant direct access to iOS Simulators and Android Emulators. Ask it to tap a button, run a profiler or reproduce an issue manually - all from within your CLI, without switching context.

```bash
npx @swmansion/argent init
```

## Capabilities

- **Autonomous iOS and Android development** - Allow your agent to work with iOS and Android apps on its own - let it build, open, interact with the app and debug it. Ask for reproducing issues, testing features manually, profiling your app and much more, without ever interrupting your work.
- **UI interaction** - Give your agent full control toolkit - tapping, swiping, pinching, typing, gestures, hardware buttons and all other gears included. Let it navigate your app exactly as a user would, without lifting a finger.
- **Profiling with batteries included** - Argent can perform and analyze both React-Native and Xcode Instruments profiling sessions. Get comprehensive summaries and ask to optimise your app where you find fit.
- **Debugging and diagnostics** - Let your agent inspect logs, capture crash reports, and reproduce failing states on the simulator, so you can jump straight to the fix.
- **React Native out of the box** - Argent works with React Native apps natively, so your agent can build, launch, and iterate on your RN project the same way it would any native app - no extra setup required.

> **Tip:** Once installed, ask your assistant _"What can Argent do?"_ - it will walk you through all capabilities available.

<br/>
<p align="center">
  <img src="https://github.com/software-mansion/argent/blob/main/assets/showcase.gif" alt="argent showcase video gif" width="100%" />
</p>

---

## Installation

#### Prerequisites

- **Node.js 18** or later
- For iOS: macOS with **Xcode** installed
- For Android: **Android SDK Platform Tools** (`adb`) on `PATH`, and the **Android Emulator** package if you want to boot AVDs from Argent. Create AVDs via Android Studio or `avdmanager`.

##### Linux host: extra prerequisites for Android emulators

Argent runs Android emulators on Linux but the default install can be slow if a few host-side knobs aren't right. Cover these once and the experience matches macOS:

- **KVM access.** The emulator falls back to slow software emulation (TCG) without `/dev/kvm`. Make sure virtualization is enabled in BIOS/UEFI (`vmx` for Intel, `svm` for AMD in `/proc/cpuinfo`) and that your user can read/write `/dev/kvm` — on most distros that means joining the `kvm` group:

  ```bash
  sudo usermod -aG kvm "$USER"
  # log out and back in so the new group takes effect
  ```

- **GPU acceleration via host OpenGL.** The Android emulator ships its own Vulkan loader that only sees the bundled software ICDs (lavapipe and SwiftShader), so `-gpu auto` on Linux silently resolves to `hw.gpu.mode=lavapipe` and rasterizes every guest frame on the CPU — even on a host with hardware Vulkan installed. Argent works around this by launching emulators with `-gpu host` on Linux, which bypasses the bundled Vulkan stack and uses your host's `libGL.so` (Mesa or NVIDIA OpenGL) for surface composition. This matches what Android Studio uses on Linux.

  For `-gpu host` to be hardware-accelerated, you need a working OpenGL driver — present on every desktop distro with a graphical session. If you're running headlessly or in a container, install your GPU's driver explicitly (`mesa-libGL` / `libgl1-mesa-glx` / `nvidia-utils`).

  Argent also runs a host-side preflight on every boot and prints a warning if `/dev/kvm` isn't usable, virtualization is disabled, or no hardware Vulkan ICD is present. The Vulkan warning is informational — Argent itself doesn't depend on Vulkan in `-gpu host` mode — but a missing hardware ICD often correlates with a missing GPU driver more broadly.

- **System image.** Prefer the `default` or `google_apis` variants of `x86_64` system images for headless agent workflows; `google_apis_playstore` adds noticeable boot-time CPU churn from Play services. Always pick `x86_64` on Intel/AMD hosts — ARM images run via QEMU translation and are dramatically slower.

- **AVD config.** AVDs created via `avdmanager create avd` default to `hw.gpu.enabled=no`. Argent overrides this with `-gpu host` at launch (so the on-disk config doesn't need editing), but if you also want to use the emulator standalone, set `hw.gpu.enabled=yes` and `hw.gpu.mode=host` in `~/.android/avd/<name>.avd/config.ini`.

#### Run `init` in your project

From your project root:

```bash
npx @swmansion/argent init
```

This command triggers an installation wizard which:

- Installs `@swmansion/argent` globally
- Detects your editor and registers the MCP server
- Copies skills, rules, and agent definitions into your workspace

#### Prefer a manual install?

```bash
npm install -g @swmansion/argent
argent init
```

## CLI Reference

| Command            | Description                                                 |
| ------------------ | ----------------------------------------------------------- |
| `argent init`      | Install globally and configure MCP in the current workspace |
| `argent install`   | Alias for `init` command                                    |
| `argent update`    | Pull the latest version and refresh workspace configuration |
| `argent remove`    | Unregister the MCP server and uninstall the package         |
| `argent uninstall` | Alias for `remove` command                                  |
| `argent mcp`       | Start MCP server instance, used internally by agent         |

## Supported Editors

`argent init` auto-detects and configures MCP for:

| Editor      | Config location                                                          |
| ----------- | ------------------------------------------------------------------------ |
| Claude Code | `.mcp.json` (project) or `~/.claude.json` (global)                       |
| Cursor      | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)            |
| VS Code     | `.vscode/mcp.json`                                                       |
| Windsurf    | `.windsurf/mcp.json`                                                     |
| Zed         | `.zed/settings.json`                                                     |
| Gemini CLI  | `.gemini/settings.json`                                                  |
| Codex CLI   | `.codex/config.yaml`                                                     |
| opencode    | `opencode.json` (project) or `~/.config/opencode/opencode.json` (global) |

## Privacy

Argent does not collect or transmit any user data.
No telemetry, no analytics, no crash reporting.

- Argent integrates with your agent locally over MCP stdio.
- Its internal tools are not reachable from outside your machine.
- The only outbound network call we make is the version check against our public npm package, which sends no user data and fails gracefully if blocked.

## License

Argent uses a mixed licensing model.

**Source code** is released under the [Apache License 2.0](LICENSE.txt).

**Proprietary binaries** (the per-platform `bin/<platform>/simulator-server` and `bin/darwin/ax-service` executables and the `.dylib` files in `native-devtools-ios`) are the intellectual property of Software Mansion S.A. and are licensed solely for use within this project. Decompiling, reverse-engineering, or redistributing them without explicit written permission is prohibited.

By using Argent, you acknowledge and agree to this structure. See [LICENSE](https://github.com/software-mansion/argent/blob/main/LICENSE.txt) for full details.

## Argent is created by Software Mansion

Since 2012 [Software Mansion](https://swmansion.com) is a software agency with experience in building web and mobile apps. We are Core React Native Contributors and experts in dealing with all kinds of React Native issues. We can help you build your next dream product – [Hire us](https://swmansion.com/contact/projects?utm_source=argent&utm_medium=readme).

[![swm](https://logo.swmansion.com/logo?color=white&variant=desktop&width=150&tag=argent-github "Software Mansion")](https://swmansion.com)
