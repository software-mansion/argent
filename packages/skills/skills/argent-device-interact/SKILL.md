---
name: argent-device-interact
description: Drive iOS, Android, or Chromium apps with Argent MCP tools. Use when tapping, swiping, typing, launching apps, waiting for UI, or taking screenshots (not for TV targets).
---

Each tool's description carries its parameters, defaults, and return shape. This skill covers routing and gotchas those descriptions don't state.

## Target Routing

- Get a `udid` from `list-devices` (or `boot-device` if none is ready). For a web app, `boot-device` with `browser` (`chrome`/`chromium`/`edge`/`brave`) launches that installed browser on a fresh profile as a `chromium` target; then `open-url` to the app. Full setup: `argent-ios-simulator-setup` / `argent-ios-device-setup` / `argent-android-emulator-setup`.
- Before driving a specialized target, read the matching instructions below:
  - Physical iPhone (`kind: "device"`): `argent-ios-device-setup` and `argent-ios-device-interact`
  - Mac app (`platform: "macos"`): `argent-macos-app-interact`
  - TV (`runtimeKind: "tv"` or `platform: "vega"`): `argent-tv-interact`
  - Chromium / HarmonyOS / foldables (`foldable: true`): `references/chromium.md`, `references/harmonyos.md`, `references/foldables.md`
- Load any deferred tool's schema (e.g. `gesture-custom`, `gesture-pinch`, `gesture-rotate`) before its first call so numbers don't serialize as strings.
- If delegating device tasks to sub-agents, ensure they have MCP permissions.

## Core Rules

- **Open apps directly:** use `launch-app` or `open-url`, never tap home-screen icons. Use `restart-app` for clean in-memory state.
- **Use the returned element tree:** interaction tools already attach a downscaled screenshot and `--- Elements after action (describe) ---` with normalized `[0,1]` tap frames. Call `describe` only when no fresh tree covers the current screen. Never derive routine tap coordinates from pixels.
- **Tree & screenshot IDs:** full trees/screenshots carry a `Tree id` / `Screenshot id`. When unchanged or slightly changed, a later result references that id (unchanged note or `-`/`+` diff); call `describe` or `screenshot` if that earlier result isn't in context. An identical tree does not mean the action did nothing.
- **Batch known steps:** use `run-sequence` when multiple consecutive steps are known ahead of time (scroll sweeps, type + enter, form fill + submit).
- **Text entry:** tap the field first (`keyboard` with no focus is a silent no-op). `keyboard` takes either `text` or `key`, not both. Keep `keyboard` as default; reserve `paste` for real paste flows (OTP, long tokens). Use `{{secret:<NAME>}}` placeholders for credentials and navigate/submit before capturing non-secure fields.
- **Wait server-side:** never poll `screenshot` or `describe` in a loop. Use `await-ui-element`, or use `await-screen-idle` before tapping moving UI.
- **Dialogs:** `describe` exposes simulator/emulator system & permission dialogs; prefer answering the app's dialog over `settings-permissions`.
- **Screenshots:** keep the default downscaled capture for UI checks; do not pass `scale: 1.0` as a tapping/readability aid.

Read `references/advanced.md` when you need: the full tool table, `network-conditions` reset, React Native LogBox dismissal, an empty `describe` tree or a `screenshot` timeout, `await-ui-element`/`await-screen-idle` edge cases, `run-sequence` gating, `paste`/secrets rules, or Android `reinstall-app` notes.
