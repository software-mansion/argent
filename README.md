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
npx @swmansion/argent@latest init
# or, in a pnpm project (where npm's devEngines check may refuse to run npx):
pnpm dlx @swmansion/argent@latest init
```

## Supported platforms

Argent drives a growing set of targets through a single toolkit, each with the right interaction model - touch, remote or mouse:

| Platform          | Targets                                                                 | Interaction      |
| ----------------- | ----------------------------------------------------------------------- | ---------------- |
| **iOS**           | Simulators, and physical iPhones over CoreDevice (experimental)         | Touch / gesture  |
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

## Physical iOS devices (experimental)

Argent can drive a **physical iPhone** — no app installed on the device — over Apple's
CoreDevice "remote control" services (the same path Xcode's device window uses). The device
interaction runs natively inside the bundled **simulator-server** (radon's `ios_device`
controller). The CoreDevice tunnel is a userspace TCP stack over the USB connection, so every
command runs unprivileged, with no admin prompt and nothing installed on the host. Supported interactions: `screenshot`, `screen-recording-start` / `screen-recording-stop`,
`gesture-tap`, `gesture-swipe`, `gesture-custom` (single touch), `keyboard`, `button`, `rotate`,
`launch-app`, `restart-app`, `reinstall-app`, `open-url`, `screenshot-diff`, `await-screen-idle`,
`await-ui-element`, `run-sequence`, and
`describe` (the live on-screen accessibility tree — see the note below). The device shows up in `list-devices` with `kind: "device"`.

**Requirements**

- macOS with **Xcode** installed (its CoreDevice Developer Disk Image must have been mounted
  once — connecting the device in Xcode does that).
- The iPhone connected, unlocked, trusted, with **Developer Mode** on.
- Verified on **iOS 27**; `describe` needs the RSDCheckin handshake iOS 26 added (the
  sim-server performs it).

**Setup**

1. Enable the feature flag:
   ```sh
   argent enable physical-ios-devices
   ```
2. Connect the iPhone (unlocked, trusted, Developer Mode on).

`list-devices` then includes the iPhone, and the supported tools work against its UDID. The
first interaction (or `boot-device`) starts the CoreDevice session automatically over USB —
no manual step, no `sudo`.

**Limitations / notes**

- `describe` returns the device's **live on-screen accessibility tree** — the frontmost app's
  elements (or the home screen), read app-free via the iOS-26+ accessibility-audit service over
  CoreDevice. It tells you **what** is on screen, not **where**. Element labels, values and traits
  (roles) are exact, but two things are not:
  - **Frames.** The accessibility read carries no geometry — the inspector publishes no frame
    attribute for an element — so every frame is a placeholder synthesised from the element's
    position in the list.
  - **Order.** The read starts from the device's current VoiceOver cursor and advances it, so
    consecutive calls return the same elements rotated by one — which also means a given element's
    synthesised frame changes between calls, and two `describe` results are not comparable. The read
    also returns at most 120 elements: past that, consecutive calls cover different parts of the
    screen rather than rotating one set, and `await-screen-idle` says so instead of waiting out its
    timeout.
  - **Identifiers.** This read does not surface accessibility identifiers, so every element comes
    back without one and an `identifier` selector matches nothing — select by label, value or role.
    Enabled/disabled and selected state _are_ reported, and land on the node's `disabled` /
    `selected` fields.

  Locate anything you intend to tap with `screenshot` first, and use `screenshot` (not `describe`)
  to tell whether the screen changed. (For pixel-exact in-app frames + taps you'd need an on-device
  XCUITest runner, which requires code-signing.)

- **Multi-touch is not available.** `gesture-pinch` and `gesture-rotate` return a clear "not
  supported" error, and `gesture-custom` rejects any event carrying a second touch point
  (`x2`/`y2`) — its single-touch sequences (long press, drag-and-drop, custom scroll) work. The
  device registers a single touch surface, `mainTouchscreen` (HID usage page `0x0D` "Digitizer" /
  usage `0x04` "Touch Screen"). Its report does carry a contact identifier, and the device accepts
  reports addressed to different ids, but iOS reads one finger off them all the same: fed
  byte-identical two-finger input that makes an iOS simulator zoom out a step, enter 3D and pinch,
  an iPhone 15 on iOS 27 did nothing, panned, and panned by exactly one contact's displacement —
  and held two contacts still long enough to fire a _single_-finger long press. The surface that
  sounds like a second candidate, `touchscreenGesture`, enumerates as usage page `0x01` "Generic
  Desktop" / usage `0x02` "Mouse" — the pointer for the mirroring window, not a second finger.

- **`await-screen-idle` ignores the read's element order here**, because that order rotates every
  call (see above). "Settled" therefore means the on-screen elements stopped changing, not that
  the pixels stopped moving: an animation with no accessibility change (a spinner) reads as
  settled. Each read is a ~2s round trip over the tunnel, so the default `timeoutMs` on a physical
  iPhone is 15s rather than the 3s used elsewhere. The same rotation makes `await-ui-element`
  reliable only for `condition: "exists"` — `visible`/`hidden` and `text`'s reading-order pick
  all read the synthesised frames, and its answer carries a `note` saying so. It gets the same
  15s default, for the same reason.

- **`reinstall-app` needs a bundle signed for this device**, since it installs through
  `devicectl device install app`. A simulator `.app`, or one whose provisioning profile does not
  list the device UDID, fails with a message saying so — as does a locked or untrusted phone,
  which reports what `devicectl` itself said rather than the signing hint.

- **Flows do not run on a physical iPhone.** `flow-execute` resolves selectors against the native
  view hierarchy, which needs argent's devtools dylib inside the app; it refuses a hardware udid up
  front rather than failing on the first selector step. Drive the phone with `describe` +
  `gesture-*` instead.

- Anything that needs argent's **native devtools** inside the target app is **not supported** and
  returns a clear "not supported" error: the native inspection tools (`native-*`) attach by
  injecting a dylib through `simctl spawn`, which has no physical-device equivalent — a real device
  would need that dylib linked into a signed build. (The `debugger-*` and `react-profiler-*` family
  is a different mechanism — it talks to the app's JS runtime through Metro, not through the
  device — so it is not gated here.) `native-profiler-*` is gated for a narrower reason: its iOS
  capture path resolves the target process and bundle through `simctl spawn` and `simctl listapps`,
  both simulator-only. The instrument itself is not the obstacle — on Xcode 16.4,
  `xctrace record --device <ecid> --attach <pid>` profiles a process on a tethered iPhone and
  returns symbolicated stacks with no code-signing identity on the host, so this one is an
  unimplemented device path rather than a platform wall. (Attach by pid: the name lookup only sees
  processes it could launch, so `--attach <name>` reports "Cannot find process" for a process that
  is running. Xcode 26.4 and later also carry the `--device` recording-start deadlock the
  simulator capture path already works around.)
  `settings-permissions` drives `simctl privacy`, which edits a simulator's TCC store on the host
  filesystem; a physical device exposes no equivalent switch. `devicectl` carries no privacy verb
  anywhere in its command tree (`device settings` covers appearance, audio, biometrics and reset),
  and installing a configuration profile instead requires a CMS-signed one, which lands back on the
  same signing requirement.

- `launch-app`, `restart-app`, `reinstall-app` and `open-url` go through `devicectl` rather than
  the CoreDevice session, so they work even before the first interaction has warmed it.

---

## Installation

#### Prerequisites

- **Node.js 20.12** or later
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
npx @swmansion/argent@latest init
# or, in a pnpm project (where npm's devEngines check may refuse to run npx):
pnpm dlx @swmansion/argent@latest init
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

#### Share Argent with your team (committable install)

By default Argent installs **globally**. To version Argent _with your repo_ so every
teammate gets the same setup on `npm install` — no per-developer global install, no
`argent init` — choose the local mode:

```bash
npx @swmansion/argent@latest init --local
# or, in a pnpm project:
pnpm dlx @swmansion/argent@latest init --local
```

> Note: in a freshly `pnpm init`-ed project, `npx` itself may refuse to run
> (npm's `devEngines` check) — use the `pnpm dlx` form there.

This adds `@swmansion/argent` to your project's `devDependencies` and writes MCP
configs that launch the project-local copy (`node node_modules/@swmansion/argent/dist/cli.js mcp`).
Commit `package.json` + your lockfile, the generated MCP config (`.mcp.json`,
`.cursor/mcp.json`, …), `.argent/install.json`, and the skills/rules/agents files.
Teammates then just run `npm install`.

Pass `--global` to force the default mode in scripts; `--local` and `--global` are
mutually exclusive. A non-interactive (`--yes`) run defaults to global unless the
project already opted into local mode (a committed `.argent/install.json`, or
`@swmansion/argent` declared in the project's own `package.json`).

> In local mode the committed MCP config runs the project-local copy, so the bare
> `argent` command is **not** on teammates' `PATH`. Note that `npm install` builds
> Argent's native deps (`tree-sitter`) on each machine — prebuilt for macOS, Linux
> x64, and Windows x64; other targets (Linux arm64, Windows arm) compile from source
> and need a C/C++ toolchain.

## CLI Reference

| Command            | Description                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `argent init`      | Install and configure MCP in the current workspace (`--global` default, `--local` for a committable devDependency)                                                                                        |
| `argent install`   | Alias for `init` command                                                                                                                                                                                  |
| `argent update`    | Pull the latest version and refresh workspace configuration (acts on the present install — both when a global install and a project devDependency coexist; `--global`/`--local` select explicitly)        |
| `argent uninstall` | Unregister the MCP server and uninstall the package (`--global`/`--local` choose which install — and its configs — is removed; non-interactive runs never remove a coexisting global install)             |
| `argent remove`    | Alias for `uninstall` command                                                                                                                                                                             |
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
