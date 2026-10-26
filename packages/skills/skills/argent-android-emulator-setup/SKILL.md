---
name: argent-android-emulator-setup
description: Set up and connect to an Android emulator using argent MCP tools. Use when starting a new session on Android, booting an emulator, getting a device serial, or before any UI interaction task.
---

## 1. Prerequisites

- **Android SDK Platform Tools** on PATH: provides `adb`.
- **Android Emulator** on PATH: needed to boot AVDs. If you will only use an already-running emulator or a physical device, adb alone is sufficient.
- An AVD created via Android Studio or `avdmanager create avd`.

Verify with `adb version` and `emulator -list-avds`.

## 2. Setup

1. **Find a ready device**: call `list-devices`. Filter for entries with `platform: "android"`. Ready devices (`state: "device"`) come first. Pick the first `serial` (e.g. `emulator-5554`) unless the user specified one.
2. **Boot if needed**: if nothing Android is ready, call `boot-device` with `avdName: <name>` from the same call's `avds` list. A snapshot boot takes ~30s; a cold boot 2–10 min.
3. **Metro (for React Native)**: once a device is up, run `adb -s <serial> reverse tcp:8081 tcp:8081` so the device can reach Metro on your host. Repeat if the device restarts.

## 3. Using the device

Pass the Android serial as `udid` to the same interaction tools as on iOS. See `argent-device-interact` for interaction tooling and the Android notes at the bottom of that skill.

## 4. Notes

- **Android TV / leanback AVDs** boot through this exact flow, but `list-devices` tags them `runtimeKind: "tv"` (a TV AVD's serial looks just like a phone's) and they are focus-driven: use the `argent-tv-interact` skill, not the gesture tools.
- `describe` on Android returns a shallower tree than iOS (no accessibility-service equivalent), but covers most tap-target discovery.
- To stop the emulator, run `adb -s <serial> emu kill` from a shell (clean shutdown). Never `pkill -9`/`kill -9` qemu: a hard kill leaves the userdata image dirty, after which cold boots can hang for many minutes doing recovery (runaway writes, `boot_completed` never flips). If an image gets into that state, boot once with `-wipe-data` to reset it.
