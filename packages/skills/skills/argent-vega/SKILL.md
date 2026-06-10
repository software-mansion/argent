---
name: argent-vega
description: Drive an Amazon Vega (Fire TV) app with argent — list/launch/restart/reinstall the app, navigate with the TV remote / D-pad, type text, read device logs, and connect the JS debugger. Use when the target is a Vega / Fire TV device (React Native for Vega, vega/kepler CLI) rather than an iOS simulator or Android emulator.
---

## What Vega is

Vega (Fire TV OS) apps are **React Native (RN 0.72, Hermes)** driven by a **D-pad TV remote**, not touch. The device is reached through the `vega`/`kepler` CLI plus a QEMU **Virtual Device (VVD)**. argent treats Vega as a third platform (`platform: "vega"`) alongside iOS/Android.

Key consequence: **use `remote` (D-pad), not `gesture-tap`/`gesture-swipe`** — touch gestures are not supported on Vega and return an "unsupported on vega" error.

## 1. Pick a target

`list-devices` includes Vega devices tagged `platform: "vega"` (e.g. `{ serial: "amazon-…", kind: "virtual", state: "running", product: "vvrp-tv-arm64" }`). Pass that `serial` as `udid` to every Vega tool. If no Vega device appears, start the VVD from a shell with `vega virtual-device start` (argent does not boot the VVD for you).

Vega tools require the Vega SDK on PATH (`source ~/vega/env`, or `~/vega/bin`). v1 targets a single running VVD; commands target the single connected device.

## 2. App lifecycle

`bundleId` on Vega is the **interactive component app id** from `manifest.toml` (e.g. `com.example.app.main`). `appPath` is a `.vpkg`.

- `reinstall-app { udid, bundleId, appPath: "…/vega_aarch64.vpkg" }` — uninstall + install.
- `launch-app { udid, bundleId }` — start the app.
- `restart-app { udid, bundleId }` — terminate + relaunch (clean in-memory state).

## 3. Navigate with the remote

`remote { udid, button, repeat? }` injects TV-remote keys. Buttons: `up`/`down`/`left`/`right` (D-pad), `select` (OK), `back`, `home`, `menu`, `playPause`, `rewind`, `fastForward`. Use `repeat` to step the D-pad several times, e.g. `remote { button: "down", repeat: 3 }` then `remote { button: "select" }`.

`keyboard { udid, text }` / `keyboard { udid, key: "enter" }` types into a focused field (e.g. a search box). On a TV, focus a text field with the D-pad first, then type.

## 4. See what's on screen — important limitation

**Screenshots do not work on the Virtual Device.** The VVD renders through host GPU acceleration that QEMU's capture path cannot read on macOS (you get a blank frame), and the on-device screenshooter is non-functional on the VVD — so `screenshot` returns an actionable error rather than a black image. (It would work on a physical Fire TV or a Linux `--no-gl-accel` VVD.)

Because of this, on Vega prefer **`read-device-logs`** and the **JS debugger** (below) to understand state, and rely on app behavior in logs to confirm navigation. Since auto-screenshot can't produce an image on the VVD, enable the **`disable-auto-screenshot`** flag while working on Vega to avoid the post-action delay (`argent disable disable-auto-screenshot` is the opposite — use the flag to turn auto-screenshot off).

## 5. Read device logs

`read-device-logs { udid, durationMs?, filter?, maxLines? }` captures the on-device log stream for a window (default 5s) and returns the text + a file artifact. Use `filter` (case-insensitive substring) to focus — e.g. `filter: "ERROR"`, an app id, or `filter: "KB key"` to confirm remote/keyboard input reached the app.

## 6. JS debugger (connect + evaluate)

argent's CDP debugger works on Vega for **connect and evaluate** (verified on RN 0.72). Prerequisites: a **Debug** build installed, Metro running (`npm start` in the app, port 8081), and the port reverse-forwarded (`vega device start-port-forwarding --port 8081 --forward false`).

- `debugger-connect { port: 8081, device_id: "0" }` → connects to the `Hermes React Native` target.
- `debugger-evaluate { port: 8081, device_id: "0", expression: "…" }` → runs JS in the app. **Use `globalThis`, not the bare `global`** (Vega's Hermes does not expose `global` in the eval scope) — e.g. `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__`.

Not yet supported on Vega: `debugger-component-tree`, `debugger-inspect-element`, and the logbox-disable step — their injected scripts use constructs (bare `global`, certain iterators) that Vega's Hermes rejects. Use `debugger-evaluate` to read state directly instead.

## 7. Profiling & crashes

Do **not** use argent's native profiler for Vega. Vega performance traces, hot-function analysis, KPI metrics, and crash (ACR) symbolication are handled by the official **`amazon-devices-buildertools-mcp`** server (`analyze_perfetto_traces`, `get_app_hot_functions`, `symbolicate_acr`). argent's React profiler (CDP-based) may work where `debugger-evaluate` does, but native profiling is out of scope.

## 8. Not supported on Vega

- `gesture-tap` / `gesture-swipe` / `gesture-pinch` / `gesture-rotate` / `gesture-custom` — touch model doesn't apply; use `remote`.
- `screenshot` on the VVD (blank-frame limitation above).
- `describe` (no accessibility tree) and `open-url` (deep-link mechanism not wired) — return unsupported on Vega.
