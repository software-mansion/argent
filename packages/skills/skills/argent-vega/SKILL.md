---
name: argent-vega
description: Control and inspect Amazon Fire TV (Vega) apps via argent — launch/restart/reinstall apps, read the on-screen element tree, navigate with the D-pad remote, type, and screenshot. Use when the task mentions Vega, Fire TV, or VVD, or involves driving a Vega virtual device.
---

# Argent Vega (Amazon Fire TV)

## Critical

- Vega is a TV platform
- **D-pad only.** Drive every interaction with `tv-remote`. Never use `gesture-*` / touch — they are unsupported on Vega.
- **Always `describe` before navigating.** Find the live cursor from the tree — the `[focused]` element, or `[selected]` when nothing reports `[focused]` (the toolkit often marks the highlighted item `[selected]` while `focused` stays false). Never guess focus position from a screenshot.
- All tools take the Vega `serial` (from `list-devices`) as `udid`.

## The navigation loop

Per screen, two calls:

1. `describe` — find the cursor (`[focused]`, or `[selected]` if no `[focused]`) and your target.
2. Compute the full D-pad path from focus → target (count rows/columns from the frames) and fire it as **one** `tv-remote {button:[...]}` ending in `select`.

Then `describe` again to confirm. On a miss, run the loop again.

## Tools

### Device lifecycle

- `list-devices` → Vega devices appear with a `serial` (use as `udid`) and a `vvdImage`. Start here to get both.
- `boot-device {vvdImage}` — starts the single SDK-managed VVD (e.g. `vvdImage:"tv"`) and returns its `serial`. Skip if `list-devices` already shows a running device.
- **Stopping the VVD** — run `vega virtual-device stop` in your shell.

### App lifecycle

- `launch-app {udid, bundleId}` — `bundleId` = interactive component app id from manifest.toml (e.g. `com.example.app.main`)
- `restart-app {udid, bundleId}` — terminate + launch
- `reinstall-app {udid, bundleId, appPath}` — uninstall + install; `appPath` = a `.vpkg`
- `describe {udid}` → on-screen element tree. The discovery tool — call before navigating
- `tv-remote {udid, button}` — D-pad; single key, path array, or `repeat`
- `keyboard {udid, text}` or `{udid, key:"enter"}` — focus the field with the D-pad first
- `screenshot {udid, scale?}` — captured host-side via `adb`

### `describe`

Nested element tree from the on-device automation toolkit — each line is a `button`/`text`/`image` with its label, `id` (test_id), `[clickable]`, and **`[focused]`/`[selected]`** + a normalized [0,1] frame. `[focused]` is the live D-pad cursor when present; in practice the toolkit usually leaves `focused` false and marks the highlighted item `[selected]`, so treat `[selected]` as the cursor whenever no element reports `[focused]`. Navigate on the tree alone. If the tree comes back empty → `restart-app` and retry.

### `tv-remote`

`button` is a single key **or a whole path**. Keys: `up`/`down`/`left`/`right`, `select`, `back`, `home`, `menu`, `playPause`, `rewind`, `fastForward`. Single: `{button:"down"}`. Repeat one key: `{button:"down", repeat:3}`. Whole path in one call: `{button:["up","right","right","select"]}` — strongly prefer this for any multi-step move.

## Fast Refresh

Needs a Debug build + Metro running. argent only connects to Metro — it does not start Metro or port-forward (any platform); do these in your shell.

1. Build a **Debug** `.vpkg` and install it: `vega device install-app -p <path/to/debug.vpkg>`
2. `npm start` (Metro on :8081; use `npm start`, not `npx react-native start`)
3. `vega device start-port-forwarding --port 8081 --forward false` (reverse)
4. `vega device launch-app -a <appId>`

Metro must be up before launch; confirm `http://localhost:8081/json/list` lists a `Hermes React Native` target. Then `.tsx` edits hot-reload live.

## Troubleshooting

- **`describe` returns an empty tree** → `restart-app` (the automation toolkit attaches at launch), then retry.
- **Keyboard / D-pad input is ignored** → enable developer mode inside the VVD: `vsm developer-mode enable`.
- **Editing `node_modules` has no effect** → you are on a Release build. Release Vega apps load JavaScript and native code split and stored on device, so patching `node_modules` only works in Debug builds.

## Platform notes

- Metro connects only on port **8081** — fixed, cannot be changed.
- Profiling / crashes → use the `amazon-devices-buildertools-mcp` server (`analyze_perfetto_traces`, `get_app_hot_functions`, `symbolicate_acr`).
- Unsupported tools, with the Vega equivalent: `gesture-*` → use `tv-remote`; `open-url` → not wired; `debugger-*` → JS debugger not supported on Vega. These fail with `Tool '<id>' is not supported on vega vvd.` (or `... is not yet implemented on vega.`).

## Knowledgebase

- Search Vega docs with the `search_documentation` tool (`amazon-devices-buildertools-mcp` server).
- Community Q&A at community.amazondeveloper.com.
