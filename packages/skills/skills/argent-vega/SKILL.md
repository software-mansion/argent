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

## 4. See what's on screen

`screenshot { udid, scale? }` works on the VVD. The VVD is an Android-emulator-derived QEMU, so capture goes host-side through the **Android emulator console** (`adb emu screenrecord screenshot` against the auto-discovered `emulator-<consolePort>`) — this grabs the composited GL display. It **requires `adb`** on PATH (the same dependency as Android). Do not run `adb connect` against the VVD's adb port — adb already auto-discovers the emulator console, and an explicit connect changes what `vega device list` reports.

(Note: a direct QMP `screendump` returns a black frame on macOS because the GL surface isn't in the QEMU console; the emulator-console path avoids that. QMP remains an internal fallback for a Linux `--no-gl-accel` VVD.)

## 5. Read device logs

`read-device-logs { udid, durationMs?, filter?, maxLines? }` captures the on-device log stream for a window (default 5s) and returns the text + a file artifact. Use `filter` (case-insensitive substring) to focus — e.g. `filter: "ERROR"`, an app id, or `filter: "KB key"` to confirm remote/keyboard input reached the app.

## 6. Live development (Fast Refresh)

Fast Refresh (hot-reload of `.tsx` edits without restarting the app) works on Vega. The one hard requirement: a **Debug** build — the debug shell loads its JS from Metro live; a Release build runs its bundled JS and silently ignores Metro.

Setup (each step in its own terminal):
1. **Debug build & install** (once, or after native changes): `npm run build:debug`, then `vega device install-app -p build/aarch64-debug/vega_aarch64.vpkg`.
2. **Metro:** `npm start` (serves the JS bundle on port 8081). Use `npm start`, not `npx react-native start` — npx may resolve the wrong CLI.
3. **Reverse port-forward:** `vega device start-port-forwarding --port 8081 --forward false` (the device dials back to your local Metro). Verify with `vega device is-port-forwarded --port 8081 --forward false` → `true`.
4. **Launch:** `vega device launch-app -a <appId>` (or `--dir .`). The app connects to Metro and loads the current source.

Order matters: Metro up **before** launching, and keep port-forwarding in its own terminal (don't reuse Metro's). Confirm the app connected by checking that `http://localhost:8081/json/list` lists a `Hermes React Native` target. After that, editing a `.tsx` pushes a live update (state preserved) within a few seconds — drive `screenshot` before/after to see it land. If a change doesn't appear, open the dev menu (press `d` in the Metro terminal) → Reload / ensure Fast Refresh is on.

## 7. JS debugger (connect + evaluate)

argent's CDP debugger works on Vega for **connect and evaluate** (verified on RN 0.72). Prerequisites are the same as Fast Refresh above (Debug build, Metro on 8081, reverse port-forward).

- `debugger-connect { port: 8081, device_id: "0" }` → connects to the `Hermes React Native` target.
- `debugger-evaluate { port: 8081, device_id: "0", expression: "…" }` → runs JS in the app. **Use `globalThis`, not the bare `global`** (Vega's Hermes does not expose `global` in the eval scope) — e.g. `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__`.

Not yet supported on Vega: `debugger-component-tree`, `debugger-inspect-element`, and the logbox-disable step — their injected scripts use constructs (bare `global`, certain iterators) that Vega's Hermes rejects. Use `debugger-evaluate` to read state directly instead.

## 8. Profiling & crashes

Do **not** use argent's native profiler for Vega. Vega performance traces, hot-function analysis, KPI metrics, and crash (ACR) symbolication are handled by the official **`amazon-devices-buildertools-mcp`** server (`analyze_perfetto_traces`, `get_app_hot_functions`, `symbolicate_acr`). argent's React profiler (CDP-based) may work where `debugger-evaluate` does, but native profiling is out of scope.

## 9. Not supported on Vega

- `gesture-tap` / `gesture-swipe` / `gesture-pinch` / `gesture-rotate` / `gesture-custom` — touch model doesn't apply; use `remote`.
- `describe` (no accessibility tree) and `open-url` (deep-link mechanism not wired) — return unsupported on Vega.
