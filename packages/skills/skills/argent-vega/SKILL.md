---
name: argent-vega
description: Drive an Amazon Vega (Fire TV) app with argent — list/launch/restart/reinstall apps, inspect the on-screen element tree (describe), navigate with the TV remote / D-pad, type text, screenshot, read device logs. Use when the target is a Vega / Fire TV device (React Native for Vega, vega/kepler CLI), not an iOS simulator or Android emulator.
---

Vega (Fire TV) apps = React Native 0.72 + Hermes on a QEMU Virtual Device (VVD), **driven by a D-pad remote (not touch)**. argent platform `"vega"`: input / screenshot / describe go over `adb`, app lifecycle over the `vega`/`kepler` CLI. Use `remote`, never `gesture-*` (gestures error on Vega).

Prereqs: Vega SDK on PATH (`source ~/vega/env`). Start the VVD yourself — `vega virtual-device start` (argent won't boot it). v1 assumes one running VVD. Input needs developer mode on the VVD (`vsm developer-mode enable` inside `kepler device shell`); without it `remote`/`keyboard` silently no-op.

## Target

`list-devices` → Vega entries tagged `platform:"vega"` (`serial:"amazon-…"`, `kind:"vvd"`). Pass that `serial` as `udid` to every Vega tool.

## App lifecycle

`bundleId` = interactive component app id from manifest.toml (e.g. `com.example.app.main`); `appPath` = a `.vpkg`.

- `launch-app {udid, bundleId}`
- `restart-app {udid, bundleId}` — terminate + relaunch
- `reinstall-app {udid, bundleId, appPath}` — uninstall + install
- `list-installed-apps {udid}` → installed app ids

## Inspect screen (describe)

`describe {udid}` → nested element tree from the on-device automation toolkit: each line is a `button`/`text`/`image` with its label, `id` (test_id), `[clickable]`, and **`[focused]`/`[selected]`** (`[focused]` is the live D-pad cursor; `[selected]` is just an active-tab/highlight state — track `[focused]`) + a normalized [0,1] frame. This is the discovery tool for Vega — call it before navigating so `remote` moves are deliberate, not blind. The toolkit auto-enables when argent launches the app; if the tree comes back empty, the app started before the toolkit attached → `restart-app` and retry. Needs `adb` on PATH. (No element-tap yet — act via `remote`.)

**`describe` is text-only — it does not auto-screenshot**, so navigate on the tree alone (it already carries focus + every label/position). Only take a real `screenshot` when you genuinely need pixels (rendering/layout/colour check).

## Input

- `remote {udid, button}` — `button` is a single key **or a whole path**. Keys: `up`/`down`/`left`/`right`, `select`, `back`, `home`, `menu`, `playPause`, `rewind`, `fastForward`. Single: `{button:"down"}`. Repeat one key: `{button:"down", repeat:3}`.
- `remote {udid, button:[...]}` — run a **whole path in one call**, e.g. `{button:["up","right","right","select"]}`. Strongly prefer this for any multi-step move.
- `keyboard {udid, text}` or `{udid, key:"enter"}` — type into a focused field (focus it with the D-pad first).

**Typing text:** focus the input field with the D-pad, and when the soft keyboard appears send the whole string in one `keyboard {udid, text:"…"}` call, then submit with `keyboard {udid, key:"enter"}`.

## Fast navigation (the loop)

Per screen, do exactly two tool calls:

1. `describe {udid}` — read the tree, find `[focused]` and the target element.
2. Compute the full D-pad path from focus → target (count rows/columns from the frames), then fire it as **one** `remote {button:[...]}` ending in `select`.

Then `describe` again to confirm. This is text-only and ~2 round-trips/screen instead of one-press-per-round-trip with a screenshot each time. Off-by-one is normal on first traversal of an unfamiliar layout — re-`describe`, correct with a short follow-up `sequence`, and you'll have the layout's geometry for the rest of the run.

**Model:** device navigation is mechanical (read tree → count steps → emit a path) — run it on a fast model (e.g. Sonnet/Haiku).

## Screenshot

`screenshot {udid, scale?}` works on the VVD; captured host-side via the Android emulator console, so it **needs `adb` on PATH**. Do **not** run `adb connect` on the VVD — adb auto-discovers it, and a manual connect breaks `vega device list`.

## Logs

`read-device-logs {udid, durationMs?, filter?, maxLines?}` — captures the log stream (default 5s) + a text artifact. `filter` = case-insensitive substring (e.g. `"ERROR"`, an app id).

## Fast Refresh (manual Metro setup)

Needs a **Debug** build + Metro running. argent only _connects_ to Metro — it does **not** start Metro or port-forward (any platform); do these in your shell. On Vega the app connects to Metro only on port **8081** — this port is fixed and cannot be changed.

1. Build a **Debug** `.vpkg` and install it: `vega device install-app -p <path/to/debug.vpkg>`
2. `npm start` (Metro on :8081; use `npm start`, not `npx react-native start`)
3. `vega device start-port-forwarding --port 8081 --forward false` (reverse)
4. `vega device launch-app -a <appId>`

Metro must be up before launch; confirm `http://localhost:8081/json/list` lists a `Hermes React Native` target. Then `.tsx` edits hot-reload live (a Release build ignores Metro).

## Out of scope

- Profiling / crashes → use the `amazon-devices-buildertools-mcp` server (`analyze_perfetto_traces`, `get_app_hot_functions`, `symbolicate_acr`), not argent's native profiler.
- `gesture-*` (use `remote`), `open-url` (not wired), `debugger-*` (JS debugger not supported on Vega) → return "unsupported on vega".
