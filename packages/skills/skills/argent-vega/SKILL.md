---
name: argent-vega
description: Drive an Amazon Vega (Fire TV) app with argent — list/launch/restart/reinstall apps, inspect the on-screen element tree (describe), navigate with the TV remote / D-pad, type text, screenshot, read device logs, connect the JS debugger. Use when the target is a Vega / Fire TV device (React Native for Vega, vega/kepler CLI), not an iOS simulator or Android emulator.
---

Vega (Fire TV) apps = React Native 0.72 + Hermes, driven by a **D-pad remote (not touch)** via the `vega`/`kepler` CLI + a QEMU Virtual Device (VVD). argent platform `"vega"`. Use `remote`, never `gesture-*` (gestures error on Vega).

Prereqs: Vega SDK on PATH (`source ~/vega/env`). Start the VVD yourself — `vega virtual-device start` (argent won't boot it). v1 assumes one running VVD.

## Target

`list-devices` → Vega entries tagged `platform:"vega"` (`serial:"amazon-…"`, `kind:"virtual"`). Pass that `serial` as `udid` to every Vega tool.

## App lifecycle

`bundleId` = interactive component app id from manifest.toml (e.g. `com.example.app.main`); `appPath` = a `.vpkg`.

- `launch-app {udid, bundleId}`
- `restart-app {udid, bundleId}` — terminate + relaunch
- `reinstall-app {udid, bundleId, appPath}` — uninstall + install
- `list-installed-apps {udid}` → installed app ids

## Inspect screen (describe)

`describe {udid}` → nested element tree from the on-device automation toolkit: each line is a `button`/`text`/`image` with its label, `id` (test_id), `[clickable]`, and **`[focused]`/`[selected]`** (where the D-pad cursor is) + a normalized [0,1] frame. This is the discovery tool for Vega — call it before navigating so `remote` moves are deliberate, not blind. The toolkit auto-enables when argent launches the app; if the tree comes back empty, the app started before the toolkit attached → `restart-app` and retry. Needs `adb` on PATH. (No element-tap yet — act via `remote`.)

## Input

- `remote {udid, button, repeat?}` — buttons: `up`/`down`/`left`/`right`, `select`, `back`, `home`, `menu`, `playPause`, `rewind`, `fastForward`. e.g. `{button:"down", repeat:3}` then `{button:"select"}`.
- `keyboard {udid, text}` or `{udid, key:"enter"}` — type into a focused field (focus it with the D-pad first).

## Screenshot

`screenshot {udid, scale?}` works on the VVD; captured host-side via the Android emulator console, so it **needs `adb` on PATH**. Do **not** run `adb connect` on the VVD — adb auto-discovers it, and a manual connect breaks `vega device list`.

## Logs

`read-device-logs {udid, durationMs?, filter?, maxLines?}` — captures the log stream (default 5s) + a text artifact. `filter` = case-insensitive substring (e.g. `"ERROR"`, an app id, `"KB key"` to confirm input reached the app).

## Fast Refresh & JS debugger (manual Metro setup)

Both need a **Debug** build + Metro running. argent only _connects_ to Metro — it does **not** start Metro or port-forward (any platform); do these in your shell:

1. `npm run build:debug` → `vega device install-app -p build/aarch64-debug/vega_aarch64.vpkg`
2. `npm start` (Metro on :8081; use `npm start`, not `npx react-native start`)
3. `vega device start-port-forwarding --port 8081 --forward false` (reverse)
4. `vega device launch-app -a <appId>`

Metro must be up before launch; confirm `http://localhost:8081/json/list` lists a `Hermes React Native` target. Then `.tsx` edits hot-reload live (a Release build ignores Metro).

Debugger (verified RN 0.72):

- `debugger-connect {port:8081, device_id:"0"}`
- `debugger-evaluate {port:8081, device_id:"0", expression:"…"}` — **use `globalThis`, not bare `global`** (Vega's Hermes rejects `global`).

Unsupported: `debugger-component-tree`, `debugger-inspect-element`, logbox-disable — their injected scripts use constructs (bare `global`, some iterators) Vega's Hermes rejects. Use `debugger-evaluate` to read state directly.

## Out of scope

- Profiling / crashes → use the `amazon-devices-buildertools-mcp` server (`analyze_perfetto_traces`, `get_app_hot_functions`, `symbolicate_acr`), not argent's native profiler.
- `gesture-*` (use `remote`), `open-url` (not wired) → return "unsupported on vega".
