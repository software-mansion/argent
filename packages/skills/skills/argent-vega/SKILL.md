---
name: argent-vega
description: Use when interacting with vega (fire tv) devices, task mentions Vega, Fire TV, VVD - list/launch/restart/reinstall apps, inspect the on-screen element tree (describe), navigate with the TV remote/D-pad, type text, screenshot
---

## Best practices

- Interactions must be driven by D-pad tv-remote tool (not touch)

## Tools

Every tool takes the Vega `serial` (from `list-devices`) as `udid`.

- `launch-app {udid, bundleId}` — `bundleId` = interactive component app id from manifest.toml (e.g. `com.example.app.main`)
- `restart-app {udid, bundleId}` — terminate + launch
- `reinstall-app {udid, bundleId, appPath}` — uninstall + install; `appPath` = a `.vpkg`
- `describe {udid}` → on-screen element tree. The discovery tool — call before navigating
- `tv-remote {udid, button}` — D-pad; single key, path array, or `repeat`
- `keyboard {udid, text}` or `{udid, key:"enter"}` — focus the field with the D-pad first
- `screenshot {udid, scale?}` — captured host-side via `adb`. Do **not** run `adb connect` on the VVD

### `describe`

Nested element tree from the on-device automation toolkit — each line is a `button`/`text`/`image` with its label, `id` (test_id), `[clickable]`, and **`[focused]`/`[selected]`** + a normalized [0,1] frame. `[focused]` is the live D-pad cursor (track this); `[selected]` is just an active-tab/highlight state. Navigate on the tree alone. If the tree comes back empty → `restart-app` and retry

### `tv-remote`

`button` is a single key **or a whole path**. Keys: `up`/`down`/`left`/`right`, `select`, `back`, `home`, `menu`, `playPause`, `rewind`, `fastForward`. Single: `{button:"down"}`. Repeat one key: `{button:"down", repeat:3}`. Whole path in one call: `{button:["up","right","right","select"]}` — strongly prefer this for any multi-step move.

### The navigation loop

Per screen, two calls: (1) `describe` — find `[focused]` and the target; (2) compute the full D-pad path from focus → target (count rows/columns from the frames) and fire it as **one** `tv-remote {button:[...]}` ending in `select`. Then `describe` again to confirm. On miss run the loop again.

## Fast Refresh

Needs a Debug build + Metro running. argent only connects to Metro — it does not start Metro or port-forward (any platform); do these in your shell.

1. Build a **Debug** `.vpkg` and install it: `vega device install-app -p <path/to/debug.vpkg>`
2. `npm start` (Metro on :8081; use `npm start`, not `npx react-native start`)
3. `vega device start-port-forwarding --port 8081 --forward false` (reverse)
4. `vega device launch-app -a <appId>`

Metro must be up before launch; confirm `http://localhost:8081/json/list` lists a `Hermes React Native` target. Then `.tsx` edits hot-reload live.

## Gotchas

- In Release mode Vega apps use Javascript and navive code stored on device (bundle split), patching node_modules only works in Debug apps
- If the input does not work, try enabling the developer mode inside VDD `vsm developer-mode enable`

## Knowledgebase

- amazon-devices-buildertools-mcp search_documentation tool
- Search the community.amazondeveloper.com


## Platform specific notes

- On Vega the app connects to Metro only on port 8081 — this port is fixed and cannot be changed
- Profiling / crashes → use the `amazon-devices-buildertools-mcp` server (`analyze_perfetto_traces`, `get_app_hot_functions`, `symbolicate_acr`)
- `gesture-*` (use `tv-remote`), `open-url` (not wired), `debugger-*` (JS debugger not supported on Vega) → return "unsupported on vega"