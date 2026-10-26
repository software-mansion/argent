---
name: argent-tv-interact
description: Control and inspect TV apps via argent, Apple TV (tvOS), Android TV (leanback), and Amazon Fire TV (Vega). Boot the target, read focus, navigate with the D-pad remote, type, screenshot, and on Vega debug the JS runtime (evaluate, console logs, network inspector). Use when a task targets a TV (runtimeKind "tv", or platform "vega"), or mentions Apple TV / tvOS / Android TV / leanback / Vega / Fire TV / VVD.
---

# Argent TV (Apple TV + Android TV + Fire TV)

## Critical

- A TV is **focus-driven, not touch-driven.** Drive every interaction with `describe` + `tv-remote` + `keyboard`; never use `gesture-*` / coordinate taps; they don't apply on any TV platform.
- **Always `describe` before navigating** to find the live cursor and your target; never guess focus from a screenshot. The cursor is the focused element; on **Vega** the toolkit often leaves `focused` false and marks the highlighted item `[selected]`, so treat `[selected]` as the cursor when nothing reports `[focused]`.
- Pass the `udid` from `list-devices`: an Apple TV simulator UDID or an Android TV / Vega `serial`. Dispatch is automatic from the id; the same tools drive all three.
- **Fire TV (Vega)** (`platform: "vega"` in `list-devices`): read `references/vega.md` before driving it. It covers booting and stopping the VVD, Fast Refresh, and debugging the JS runtime.

## The navigation loop

1. `describe`: find the cursor and your target (returns the focused element + all focusable ones, not a tap tree).
2. `tv-remote`: move focus toward the target. Prefer **one** call with a path ending in `select`, e.g. `{button:["down","right","select"]}`; count rows/columns from the frames to build the path.
3. `describe` again to confirm. On a miss, repeat.

## Tools

`describe`, `tv-remote` and `keyboard` descriptions cover the TV behaviour (focus view, remote keys and paths, text-only typing). Beyond them:

- `launch-app` / `restart-app` / `reinstall-app` take the `bundleId` from the app manifest.

## Per-platform

### Apple TV (tvOS simulator)

- Boot like any iOS sim (`boot-device`); the AX + HID daemons auto-start on the first `describe` / `tv-remote` (first call may take a few seconds).
- Dev build: `open-url {udid, url:"<scheme>://expo-development-client/?url=http%3A%2F%2F<HOST_IP>%3A8081"}` (`<HOST_IP>` = your Mac's LAN IP, shown on the launcher).

### Android TV (leanback emulator)

- Boot the leanback AVD like any emulator; see `argent-android-emulator-setup`.
- Dev build: `open-url` `<scheme>://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081` (`<scheme>`: the app's URL scheme, or its package name if it sets none), then dismiss the first dev menu with `tv-remote` `select` (not `back`: it exits the app).

## Fast Refresh (dev builds)

Needs a Debug build + Metro running. argent only _connects_ to Metro: start Metro yourself, and forward the port where the app needs it (Android: `argent-metro-debugger` §1; Vega: `references/vega.md`).

- **Apple TV / Android TV:** use the dev-build deep-links above; `npm start` for Metro.
- **Vega:** see `references/vega.md`.
