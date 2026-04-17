---
name: argent-android-emulator-setup
description: Set up and connect to an Android emulator using argent MCP tools. Use when starting a new session on Android, booting an emulator, getting a device serial, or before any UI interaction task.
---

## 1. Prerequisites

- **Android SDK Platform Tools** on PATH — provides `adb`.
- **Android Emulator** on PATH — needed to boot AVDs via `android-boot-emulator`. If you will only use an already-running emulator or a physical device, adb alone is sufficient.
- An AVD created via Android Studio or `avdmanager create avd`.

Verify with `adb version` and `emulator -list-avds`.

## 2. Setup

1. **Find a ready device** — call `android-list-emulators`. Ready devices have `state: "device"` and come first. Pick the first serial (e.g. `emulator-5554`) unless the user specified one.
2. **Boot if needed** — if nothing is ready, call `android-boot-emulator` with the AVD `name` from the same call's `avds` list. The tool cold-boots by default (reliability over speed — 2–5 min typical) and returns a clean `serial`. On any stage failure it kills the emulator process it started, so your next call begins from a clean state.
3. **Metro (for React Native)** — once a device is up, run `adb -s <serial> reverse tcp:8081 tcp:8081` so the device can reach Metro on your host. Repeat if the device restarts. See the `argent-metro-debugger` skill.

## 3. Using the device

Pass the Android serial as `udid` to the unified interaction tools — `tap`, `swipe`, `describe`, `screenshot`, `launch-app`, `keyboard`, etc. The tool-server auto-dispatches based on the id shape. See `argent-simulator-interact` (the base interaction skill, platform-neutral) and `argent-android-emulator-interact` (Android-specific gotchas).

## 4. Notes

- Serials are the adb device id. iOS UDIDs and Android serials are not interchangeable, but you do NOT need to tell the tools which platform — dispatch is automatic.
- Android does not have the iOS native-devtools dylib equivalent. `describe` uses `uiautomator` on Android, which is shallower than the iOS AX tree but covers most tap-target discovery.
- For first-launch permission prompts, pass `grantPermissions: true` to `reinstall-app`.
- To kill the emulator when you're done, run `adb -s <serial> emu kill` from a shell.
