---
name: argent-tv-interact
description: Control and inspect TV apps via argent — Apple TV (tvOS), Android TV (leanback), and Amazon Fire TV (Vega). Boot the target, read focus, navigate with the D-pad remote, type, screenshot, and on Vega debug the JS runtime (evaluate, console logs, network inspector). Use when a task targets a TV (runtimeKind "tv", or platform "vega"), or mentions Apple TV / tvOS / Android TV / leanback / Vega / Fire TV / VVD.
---

# Argent TV (Apple TV + Android TV + Fire TV)

## Critical

- A TV is **focus-driven, not touch-driven.** Drive every interaction with `describe` + `tv-remote` + `keyboard`; never use `gesture-*` / coordinate taps — they don't apply on any TV platform.
- **Always `describe` before navigating** to find the live cursor and your target — never guess focus from a screenshot. The cursor is the focused element; on **Vega** the toolkit often leaves `focused` false and marks the highlighted item `[selected]`, so treat `[selected]` as the cursor when nothing reports `[focused]`.
- Pass the `udid` from `list-devices` — an Apple TV simulator UDID or an Android TV / Vega `serial`. Dispatch is automatic from the id; the same tools drive all three.

## The navigation loop

1. `describe` — find the cursor and your target (returns the focused element + all focusable ones, not a tap tree).
2. `tv-remote` — move focus toward the target. Prefer **one** call with a path ending in `select`, e.g. `{button:["down","right","select"]}`; count rows/columns from the frames to build the path.
3. `describe` again to confirm. On a miss, repeat.

## Tools

- `describe {udid}` — focus view: the focused / `[selected]` element + focusable elements with labels and normalized frames. The discovery tool — call before and after navigating. Empty tree → see the per-platform notes.
- `tv-remote {udid, button}` — D-pad / remote. `button` is one key **or a whole path** (run in one call). Keys: `up`/`down`/`left`/`right`, `select`, `back`, `menu`, `home`, `playPause`, plus media keys `rewind`/`fastForward`/`next`/`previous`/`volumeUp`/`volumeDown`/`mute`. Single: `{button:"down"}`; repeat: `{button:"down", repeat:3}`; path: `{button:["up","right","select"]}`.
- `keyboard {udid, text}` — type into the focused field (focus it with `tv-remote` first). One call carries `text`, `key` or `clear`, never two — to replace a value, send `{clear:true}` then `{text:"…"}` in one `run-sequence`. Named `key` presses (e.g. `{key:"enter"}`) work on Vega; on Apple TV / Android TV move focus with `tv-remote` instead.
- `keyboard {udid, clear:true}` — empty the focused field. Works on all three, over the channel each one types through, and nothing is read back: the result says the burst was SENT (`keys: 200`, no `clearVerified`). To prove the field is empty, read it back — but not with `describe` on Apple TV, whose focus view carries no field value (it reports the presented keyboard and its `done` button); use a `screenshot`, or the app's own visible state, there. On Android TV and Vega `describe` does report the focused field's value. **Focus first, and give it ~500ms**: no backend checks focus, so a clear that arrives early empties whatever was focused before and still reports success — put the `tv-remote` presses and the clear in ONE `run-sequence`. Apple TV (~9s) and Android TV send 100 backspaces interleaved with 100 forward-deletes, so the cursor can sit anywhere and a field longer than 100 characters per side keeps the remainder — call it again. Vega (~10s) has no forward delete, so it sends 200 backspaces: it reaches 200 characters BEHIND the cursor and never touches text ahead of it. A remote (`ios-remote`) Apple TV is the one target that refuses it, and refuses `key` too — the tvOS daemons drive a simulator in the tool-server host's own CoreSimulator set, so `tv-remote` and the TV `describe` view do not reach one behind sim-remote either. Run against a LOCAL Apple TV simulator.
- `launch-app` / `restart-app` / `reinstall-app {udid, bundleId}` — `bundleId` from the app manifest. Vega `reinstall-app` takes `appPath` = a `.vpkg`.
- `screenshot {udid, scale?}` — Apple TV via `xcrun simctl io` (downscaled); Android TV / Vega host-side via `adb` / `screencap`.

## Per-platform

### Apple TV (tvOS simulator)

- Boot like any iOS sim (`boot-device`); the AX + HID daemons auto-start on the first `describe` / `tv-remote` (first call may take a few seconds). Give the RN bundle a few seconds to render before the first `describe`.
- Media-transport / volume keys are **rejected** — the sim's HID stack ignores them (they work on Android TV / Vega).
- Dev build: `open-url {udid, url:"<scheme>://expo-development-client/?url=http%3A%2F%2F<HOST_IP>%3A8081"}` (`<HOST_IP>` = your Mac's LAN IP, shown on the launcher).

### Android TV (leanback emulator)

- Boot the leanback AVD like any emulator — see `argent-android-emulator-setup`.
- **`describe` may report zero focusables on a screen with visible tiles**: many `react-native-tvos` screens use RN's own focus engine, invisible to the OS accessibility tree. `describe` auto-falls-back to the full UI tree (and says so in the hint); `tv-remote` still moves focus, so drive blind + `screenshot` to confirm.
- Dev build: `adb -s <serial> reverse tcp:8081 tcp:8081`, deep-link `<pkg>://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081`, dismiss the first dev-menu with `adb shell input keyevent KEYCODE_DPAD_CENTER` (not Back — Back exits the app).

### Fire TV (Vega / VVD)

- `list-devices` shows a `serial` (use as `udid`) and a `vvdImage`. `boot-device {vvdImage}` (e.g. `"tv"`) starts the single SDK-managed VVD; skip if one already runs.
- **Stop the VVD** with `vega virtual-device stop` in your shell. The CLI only tracks VVDs it started in the foreground, so it may report "not running" for one started via `boot-device`; to restart that one use `boot-device {vvdImage, force:true}` (stops then re-boots).
- Empty `describe` tree → `restart-app` (the automation toolkit attaches at launch), then retry. Input ignored → enable developer mode in the VVD: `vsm developer-mode enable`.
- Editing `node_modules` has no effect on a Release build — only Debug `.vpkg` builds load patchable JS.
- Profiling / crashes → `amazon-devices-buildertools-mcp` server (`analyze_perfetto_traces`, `get_app_hot_functions`, `symbolicate_acr`); docs via its `search_documentation` tool.

## Common gotchas

- **Empty focus right after `launch-app` / `restart-app`** is the splash / loading window — `describe` retries internally; wait ~2-3s and retry on a cold start.
- Passing a phone/tablet (`runtimeKind: "mobile"`) udid to `tv-remote` fails with a clear "tvOS-only" / "Android-TV-only" error — pick a TV target from `list-devices`.

## Fast Refresh (dev builds)

Needs a Debug build + Metro running. argent only _connects_ to Metro — start Metro and port-forward yourself (any platform). Metro is fixed on **:8081**.

- **Apple TV / Android TV:** use the dev-build deep-links above; `npm start` for Metro.
- **Vega:** build/install a Debug `.vpkg` (`vega device install-app -p <path>`), `npm start`, `vega device start-port-forwarding --port 8081 --forward false`, then `vega device launch-app -a <appId>`. Confirm `http://localhost:8081/json/list` shows a `Hermes React Native` target; `.tsx` edits then hot-reload.

## Debugging the JS runtime (Vega)

Once that same Debug build + Metro setup is in place, the JS-runtime tools work on a Vega VVD: `debugger-connect`, `debugger-status`, `debugger-evaluate`, `debugger-log-registry` (console logs), `view-network-logs`, and `view-network-request-details`. Verify with `debugger-status`: it returns a status result rather than an error when not connected — `status: "connected"` means the setup works; `status: "not_connected"` carries a `reason` and `guidance` (e.g. `metro_not_running` → Metro itself is not up). Vega-specific: on `no_app_connected`, check `vega device start-port-forwarding` **before** relaunching the app — a down device→host forward is the usual cause, and the generic guidance can't know about it. See the `argent-metro-debugger` skill.

Vega's React Native forks RN 0.72 and serves the legacy Hermes inspector, so three things differ from iOS / Android:

- `debugger-component-tree`, `debugger-inspect-element`, `debugger-reload-metro` and the `react-profiler-*` / `profiler-*` tools are **not supported**. Component-tree and inspect-element are hard-blocked: they need `Runtime.addBinding`, which this Hermes acknowledges but never installs. The rest are simply unverified on the legacy inspector. Use `describe` for on-screen structure; with both component tools gated off, component `file:line` tracing has no path on Vega.
- `debugger-status` reports `isNewDebugger: false`.
- `projectRoot` is empty (RN 0.72's Metro sends no project-root header), so lookups that resolve paths against the project root return no location.
