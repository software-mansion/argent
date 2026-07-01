<br/>
<p align="center">
  <a href="https://argent.swmansion.com">
    <img width="1100" height="382" alt="argent-header" src="https://github.com/user-attachments/assets/6cec01d5-da3c-4b6c-97c3-0374a63c213c" />
  </a>
</p>

[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-1?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-1&n=1)
[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-2?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-2&n=1)
[![Ad](https://swm-delivery.com/www/images/zone-gh-argent-3?n=1)](https://swm-delivery.com/www/delivery/ck-slug.php?zoneid=zone-gh-argent-3&n=1)

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

## Physical iOS devices (experimental)

Argent can drive a **physical iPhone** — no app installed on the device — over Apple's
CoreDevice "remote control" services (the same path Xcode's device window uses), via
[`pymobiledevice3`](https://github.com/doronz88/pymobiledevice3). Supported interactions:
`screenshot`, `gesture-tap`, `gesture-swipe`, `button`, and `launch-app`. The device shows
up in `list-devices` with `kind: "device"`.

**Requirements**

- **iOS 27 or later for tap/swipe** — Apple gates host-driven touch input to iOS 27+; on
  earlier versions those commands report `CoreDeviceError 9021`. Screenshot and hardware
  buttons work on earlier iOS versions too.
- macOS with Xcode, and `pymobiledevice3` installed (e.g. `pipx install pymobiledevice3`).
- The iPhone connected, unlocked, trusted, with **Developer Mode** on.

**Setup**

1. Enable the feature flag:
   ```sh
   argent enable physical-ios-devices
   ```
2. Connect the iPhone (unlocked, trusted, Developer Mode on).

`list-devices` then includes the iPhone, and the supported tools work against its UDID.
The first interaction (or `boot-device`) starts the required CoreDevice tunnel
automatically: Argent shows a standard macOS authorization prompt (Touch ID / password)
to launch `pymobiledevice3 remote tunneld` as root (creating the tunnel interface needs
root once; every other command runs unprivileged). No manual `sudo`. When the signed
`argent-device-auth` helper is installed, the prompt is branded as Argent; otherwise it's
the system's default admin prompt.

If the prompt is declined or there's no GUI session (headless), start the tunnel manually
and leave it running: `sudo pymobiledevice3 remote tunneld`.

**Limitations / notes**

- Not supported on physical iOS yet: `describe` / accessibility inspection (use `screenshot`
  instead), keyboard/typing, pinch & rotate (multi-touch), `open-url`, `reinstall-app`,
  `restart-app`, and the native inspection / profiling tools (`native-*`, `native-profiler-*`,
  `screenshot-diff`) — all return a clear "not supported" error. `launch-app` (via `devicectl`)
  works independently of the CoreDevice tunnel — it can succeed even before the tunnel setup
  above has run.
- Overrides: `ARGENT_PYMOBILEDEVICE3` (path to the binary), `ARGENT_PMD3_TUNNELD_PORT`
  (defaults to `49151`).

---

## Installation

#### Prerequisites

- **Node.js 20.11** or later
- For iOS: macOS with **Xcode** installed
- For Android: **Android SDK Platform Tools** (`adb`) on `PATH`, and the **Android Emulator** package if you want to boot AVDs from Argent. Create AVDs via Android Studio or `avdmanager`.

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

| Command            | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `argent init`      | Install globally and configure MCP in the current workspace            |
| `argent install`   | Alias for `init` command                                               |
| `argent update`    | Pull the latest version and refresh workspace configuration            |
| `argent remove`    | Unregister the MCP server and uninstall the package                    |
| `argent uninstall` | Alias for `remove` command                                             |
| `argent mcp`       | Start MCP server instance, used internally by agent                    |
| `argent enable`    | Enable a predefined feature flag (`--scope project` for project-local) |
| `argent disable`   | Disable a feature flag (`--scope project` for project-local)           |
| `argent flags`     | List available feature flags and their state                           |
| `argent telemetry` | Manage anonymous telemetry: `status` / `enable` / `disable`            |

## Supported Editors

`argent init` auto-detects and configures MCP for:

| Editor      | Config location                                                             |
| ----------- | --------------------------------------------------------------------------- |
| Claude Code | `.mcp.json` (project) or `~/.claude.json` (global)                          |
| Cursor      | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global)               |
| VS Code     | `.vscode/mcp.json`                                                          |
| Windsurf    | `~/.codeium/windsurf/mcp_config.json` (global)                              |
| Zed         | `.zed/settings.json`                                                        |
| Gemini CLI  | `.gemini/settings.json`                                                     |
| Codex CLI   | `.codex/config.toml` (project) or `~/.codex/config.toml` (global)           |
| Hermes      | `~/.hermes/config.yaml` (global)                                            |
| opencode    | `opencode.json` (project) or `~/.config/opencode/opencode.json` (global)    |
| Kiro        | `.kiro/settings/mcp.json` (project) or `~/.kiro/settings/mcp.json` (global) |

## Privacy

Argent collects anonymous, opt-out usage and diagnostic telemetry to help us prioritise features and fix what breaks. It is minimal by design.

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
