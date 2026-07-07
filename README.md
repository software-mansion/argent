<br/>
<p align="center">
  <a href="https://argent.swmansion.com">
    <img width="1100" height="382" alt="argent-header" src="https://github.com/user-attachments/assets/6cec01d5-da3c-4b6c-97c3-0374a63c213c" />
  </a>
</p>

[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-1?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-1&n=1)
[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-2?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-2&n=1)
[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-3?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-3&n=1)

**[Argent](https://argent.swmansion.com)** is an **agentic toolkit** that gives your AI assistant direct access to iOS Simulators, Android emulators and physical devices, TVs (Apple TV, Android TV, Fire TV) and Electron/Chromium desktop and web apps. Ask it to tap a button, run a profiler or reproduce an issue manually - all from within your CLI, without switching context.

```bash
npx @swmansion/argent init
```

## Supported platforms

Argent drives a growing set of targets through a single toolkit, each with the right interaction model - touch, remote or mouse:

| Platform          | Targets                                                                 | Interaction      |
| ----------------- | ----------------------------------------------------------------------- | ---------------- |
| **iOS**           | Simulators                                                              | Touch / gesture  |
| **Android**       | Emulators (AVDs) and physical devices over adb                          | Touch / gesture  |
| **TV**            | Apple TV (tvOS), Android TV / Google TV, Amazon Fire TV (Vega)          | D-pad / remote   |
| **Desktop & web** | Electron and Chromium apps (incl. React Native Web / Expo web) over CDP | Mouse / keyboard |

## Capabilities

- **Autonomous mobile, TV and desktop development** - Allow your agent to work with iOS, Android, TV and Electron/web apps on its own - let it build, open, interact with the app and debug it. Ask for reproducing issues, testing features manually, profiling your app and much more, without ever interrupting your work.
- **UI interaction** - Give your agent the full control toolkit - tapping, swiping, pinching, typing, gestures and hardware buttons on mobile; the directional remote on TV; mouse, scroll and drag on desktop/web. Let it navigate your app exactly as a user would, without lifting a finger.
- **Record & replay flows** - Capture a sequence of interactions once and let your agent replay it deterministically, so manual repros and smoke tests become repeatable.
- **Visual regression** - Diff two screenshots (or a saved baseline against a live capture) with OCR- and font-aware comparison to catch unintended UI changes.
- **Profiling with batteries included** - Argent can perform and analyze React Native (Hermes), React DevTools and native (Xcode Instruments / Android Perfetto) profiling sessions - down to fiber renders, CPU hotspots and cross-correlated commit-vs-hang reports. Get comprehensive summaries and ask to optimise your app where you find fit.
- **Debugging and diagnostics** - Let your agent inspect logs, capture network traffic (JS `fetch` and native), evaluate JS in the running app, walk the native UIKit and React component trees, and reproduce failing states - so you can jump straight to the fix.
- **Desktop & web control** - For Electron and Chromium apps your agent can drive tabs, read and write cookies and storage, walk the DOM and inspect network over the Chrome DevTools Protocol.
- **React Native out of the box** - Argent works with React Native apps natively, so your agent can build, launch, and iterate on your RN project the same way it would any native app - no extra setup required.

> **Tip:** Once installed, ask your assistant _"What can Argent do?"_ - it will walk you through all capabilities available.

<br/>
<p align="center">
  <img src="https://github.com/software-mansion/argent/blob/main/assets/showcase.gif" alt="argent showcase video gif" width="100%" />
</p>

---

## Installation

#### Prerequisites

- **Node.js 20.11** or later
- For iOS / tvOS: macOS with **Xcode** installed (Apple TV uses tvOS simulators — Xcode downloads the tvOS runtime on demand)
- For Android / Android TV: **Android SDK Platform Tools** (`adb`) on `PATH`, and the **Android Emulator** package if you want to boot AVDs from Argent. Create AVDs via Android Studio or `avdmanager`.
- For Fire TV (Vega): the **Vega SDK** (`vega` CLI) on `PATH`
- For Electron / Chromium: nothing extra to control an already-running app - just launch it with `--remote-debugging-port`, or let Argent spawn your Electron app for you

##### Linux host: extra prerequisites for Android emulators

Argent runs Android emulators on Linux but the default install can be slow if a few host-side knobs aren't right. Cover these once and the experience matches macOS:

- **KVM access.** The emulator falls back to slow software emulation (TCG) without `/dev/kvm`. Make sure virtualization is enabled in BIOS/UEFI (`vmx` for Intel, `svm` for AMD in `/proc/cpuinfo`) and that your user can read/write `/dev/kvm` — on most distros that means joining the `kvm` group:

  ```bash
  sudo usermod -aG kvm "$USER"
  # log out and back in so the new group takes effect
  ```

- **GPU mode (`-gpu swiftshader` on Linux, override available).** The Android emulator's Linux GPU story is messy: `-gpu auto` frequently resolves to lavapipe (slow software Vulkan via host libvulkan, ~10× cold-boot regression on flagship hardware), and `-gpu host` silently produces a corrupted or black emulator window on hosts with non-trivial GL stacks — dual-GPU / Optimus laptops, NVIDIA + Mesa coexistence via libglvnd, Wayland sessions on hybrid graphics, headless / containerized hosts. The failure mode is invisible to argent's framebuffer-based screenshot tool, so an agent reports success while the developer sees a black window.

  Argent picks `-gpu swiftshader` on Linux for universal compatibility: it sidesteps the host GL stack entirely and renders via the emulator's bundled SwiftShader. On modern multi-core machines this is indistinguishably smooth from hardware-accelerated `-gpu host` (and far faster than lavapipe).

  Override with the `ARGENT_EMULATOR_GPU_MODE` env var if you've verified `-gpu host` works on your machine (typical single-GPU Mesa box with a healthy X session):

  ```bash
  ARGENT_EMULATOR_GPU_MODE=host argent ...
  ```

  Argent's boot-device preflight prints a warning if `/dev/kvm` isn't usable — the condition that causes a 10–50× TCG-vs-KVM slowdown.

- **System image.** Prefer the `default` or `google_apis` variants of `x86_64` system images for headless agent workflows; `google_apis_playstore` adds noticeable boot-time CPU churn from Play services. Always pick `x86_64` on Intel/AMD hosts — ARM images run via QEMU translation and are dramatically slower.

- **AVD config.** AVDs created via `avdmanager create avd` default to `hw.gpu.enabled=no`. Argent overrides this with an explicit `-gpu` arg at launch (so the on-disk config doesn't need editing). For the smoothest experience under heavy native builds (gradle compilations alongside the AVD), bump the AVD's RAM and CPU count — edit `~/.android/avd/<name>.avd/config.ini`:

  ```
  hw.ramSize = 8192
  hw.cpu.ncore = 6
  vm.heapSize = 512
  ```

  Stock 2 GB / 4 vCPU AVDs can be CPU-starved into wedged-system_server states by a concurrent gradle/Kotlin compile.

- **Headless / CI mode (`ARGENT_EMULATOR_NO_WINDOW=1`).** Argent shows the emulator window by default so a local developer can see the AVD UI. In a headless context — CI runner, container, or a Wayland-only session where the emulator's bundled Qt has no `wayland` platform plugin and SIGABRTs on the crash-consent dialog — opt out by exporting `ARGENT_EMULATOR_NO_WINDOW=1` before starting the tool-server. This appends `-no-window` to the spawn args, selecting `qemu-system-x86_64-headless` which doesn't need a Qt window. Argent's screencap-based screenshot tool reads the in-memory framebuffer correctly without a visible window.

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

| Command            | Description                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `argent init`      | Install globally and configure MCP in the current workspace                                                                                                                                               |
| `argent install`   | Alias for `init` command                                                                                                                                                                                  |
| `argent update`    | Pull the latest version and refresh workspace configuration                                                                                                                                               |
| `argent remove`    | Unregister the MCP server and uninstall the package                                                                                                                                                       |
| `argent uninstall` | Alias for `remove` command                                                                                                                                                                                |
| `argent mcp`       | Start MCP server instance, used internally by agent                                                                                                                                                       |
| `argent tools`     | List tools exposed by the tool-server (`describe <name>` for details)                                                                                                                                     |
| `argent run`       | Invoke a tool by name                                                                                                                                                                                     |
| `argent server`    | Manage the shared tool-server: `start` / `status` / `stop` / `logs`                                                                                                                                       |
| `argent lens`      | Open Argent Lens bound to a fresh coding-agent session — Claude by default, `--agent` selects codex/gemini/opencode/cursor (macOS; behind the `argent-lens` flag — run `argent enable argent-lens` first) |
| `argent link`      | Route client requests to a remote tool-server                                                                                                                                                             |
| `argent unlink`    | Remove the persisted remote tool-server link                                                                                                                                                              |
| `argent enable`    | Enable a predefined feature flag (`--scope project` for project-local)                                                                                                                                    |
| `argent disable`   | Disable a feature flag (`--scope project` for project-local)                                                                                                                                              |
| `argent flags`     | List available feature flags and their state                                                                                                                                                              |
| `argent telemetry` | Manage telemetry: `status` / `enable` / `disable`                                                                                                                                                         |

## Supported Editors

`argent init` auto-detects and configures MCP for:

| Editor      | Config location                                                             |
| ----------- | --------------------------------------------------------------------------- |
| Claude Code | `.mcp.json` (project) or `~/.claude.json` (global)                          |
| Cursor      | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)               |
| VS Code     | `.vscode/mcp.json`                                                          |
| Windsurf    | `~/.codeium/windsurf/mcp_config.json` (global)                              |
| Zed         | `.zed/settings.json` (project) or `~/.config/zed/settings.json` (global)    |
| Gemini CLI  | `.gemini/settings.json`                                                     |
| Codex CLI   | `.codex/config.toml` (project) or `~/.codex/config.toml` (global)           |
| Hermes      | `~/.hermes/config.yaml` (global)                                            |
| opencode    | `opencode.json` (project) or `~/.config/opencode/opencode.json` (global)    |
| Kiro        | `.kiro/settings/mcp.json` (project) or `~/.kiro/settings/mcp.json` (global) |

## Privacy

Argent collects opt-out usage and diagnostic telemetry to help us prioritise features and fix what breaks.

You can opt out at any time:

```bash
argent telemetry disable   # check status with: argent telemetry status
```

For the full details — see the [Argent Privacy Notice (Telemetry)](https://github.com/software-mansion/argent/blob/main/Telemetry.md).

## License

Argent uses a mixed licensing model.

**Source code** is released under the [Apache License 2.0](LICENSE.txt).

**Proprietary binaries** (the per-platform `bin/<platform>/simulator-server` and `bin/darwin/ax-service` executables and the `.dylib` files in `native-devtools-ios`) are the intellectual property of Software Mansion S.A. and are licensed solely for use within this project. Decompiling, reverse-engineering, or redistributing them without explicit written permission is prohibited.

By using Argent, you acknowledge and agree to this structure. See [LICENSE](https://github.com/software-mansion/argent/blob/main/LICENSE.txt) for full details.

## Argent is created by Software Mansion

Since 2012 [Software Mansion](https://swmansion.com) is a software agency with experience in building web and mobile apps. We are Core React Native Contributors and experts in dealing with all kinds of React Native issues. We can help you build your next dream product – [Hire us](https://swmansion.com/contact/projects?utm_source=argent&utm_medium=readme).

[![swm](https://logo.swmansion.com/logo?color=white&variant=desktop&width=150&tag=argent-github "Software Mansion")](https://swmansion.com)
