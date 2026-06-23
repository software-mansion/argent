---
name: argent-tv-interact
description: Control and inspect Apple TV (tvOS) and Android TV (leanback) apps via argent — boot the target, read the on-screen focus state, navigate with the D-pad remote, and type. Use when a task targets a TV (a `list-devices` entry with `runtimeKind: "tv"`), or when the user mentions Apple TV / tvOS / Android TV / leanback.
---

# Argent TV (Apple TV + Android TV)

## Critical

- A TV is **focus-driven, not touch-driven.** Drive every interaction with `tv-remote`; never use `gesture-*` / coordinate taps — they don't apply.
- **Always `describe` before navigating** to find the live focus (the `→`-marked / focused element) and your target. Never guess focus from a screenshot.
- The same tools drive both platforms; dispatch is automatic from the id. Pass an Apple TV simulator UDID or an Android TV `serial` (from `list-devices`) as `udid`.
- For Amazon Fire TV (Vega) see `argent-vega` instead — same `tv-remote` / `describe` model, different platform.

## Setup

Call `list-devices` and pick a `runtimeKind: "tv"` entry. If none is booted, `boot-device` first (Android TV: boot the leanback AVD like any emulator — see `argent-android-emulator-setup`). Apple TV's daemons auto-start on the first `tv-remote` / `describe` call (first call may take a few seconds).

**Dev builds (Expo dev-client / `react-native-tvos` debug)** boot into a dev-launcher, not the app. Point it at a running Metro (you start Metro yourself):

- **Apple TV:** `open-url {udid, url:"<scheme>://expo-development-client/?url=http%3A%2F%2F<HOST_IP>%3A8081"}` (`<HOST_IP>` = your Mac's LAN IP, shown on the launcher).
- **Android TV:** `adb -s <serial> reverse tcp:8081 tcp:8081`, then deep-link `<pkg>://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081`. Dismiss the first-load dev-menu with `adb shell input keyevent KEYCODE_DPAD_CENTER` (not Back — Back exits the app).

Give the RN bundle a few seconds to render before the first `describe` (focus only exists once JS has run).

## The navigation loop

1. `describe` — find the focused element and your target (it returns the focused element + all focusable ones, not a tap tree).
2. `tv-remote` — move focus toward the target; prefer one call with a path ending in `select`, e.g. `{button:["down","right","select"]}`.
3. `describe` again to confirm. On a miss, repeat.

## Tools

- `describe {udid}` — focus view: the focused element + focusable elements with labels and normalized frames. The discovery tool — call before and after navigating.
- `tv-remote {udid, button}` — D-pad / remote. `button` is one key **or a whole path** (run in one call): `up`/`down`/`left`/`right`, `select`, `back`, `menu`, `home`, `playPause`. Single: `{button:"down"}`; repeat: `{button:"down", repeat:3}`; path: `{button:["up","right","select"]}`. Media-transport / volume keys (`rewind`/`fastForward`/`next`/`previous`/`volumeUp`/`volumeDown`/`mute`) work on Android TV; on the Apple TV simulator they're rejected (its HID stack ignores them).
- `keyboard {udid, text}` — type into the focused field (focus it with `tv-remote` first). Named `key` presses are not supported on TV — move focus with `tv-remote` instead.
- `screenshot {udid}` — Apple TV captures via `xcrun simctl io` (4K, downscaled); Android TV via the standard `screencap` path.

## Gotchas

- **Android TV: `describe` may report zero focusables on a screen that clearly has tiles.** Many `react-native-tvos` screens use RN's own focus engine, invisible to the OS accessibility tree. `describe` auto-falls-back to the full UI tree (and says so in the hint); `tv-remote` still moves focus, so drive blind + `screenshot` to confirm.
- **Empty focus right after `launch-app` / `restart-app`** is the splash/loading window — `describe` retries internally; wait ~2-3s and retry on a cold dev-client start.
- Passing a phone/tablet (`runtimeKind: "mobile"`) udid to `tv-remote` fails with a clear "tvOS-only" / "Android-TV-only" error — use `list-devices` and pick a `runtimeKind: "tv"` entry.
