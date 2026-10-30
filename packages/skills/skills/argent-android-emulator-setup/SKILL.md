---
name: argent-android-emulator-setup
description: Set up and connect to an Android emulator using argent MCP tools. Use when starting a new session on Android, booting an emulator, getting a device serial, or before any UI interaction task.
---

## 1. Prerequisites

The Android SDK (platform tools and emulator) and an AVD, created in Android Studio or with `avdmanager create avd`. If `list-devices` returns no Android devices and no `avds`, either no AVD exists or Argent can't find the SDK: set `ANDROID_HOME`, or run `argent config set android.sdkRoot <sdk-path>`.

## 2. Setup

1. **Find a ready device**: call `list-devices`. Filter for entries with `platform: "android"`. Ready devices (`state: "device"`) come first. Pick the first with `kind: "emulator"` that is not `runtimeKind: "tv"`, unless the user named a device. If the result has a `hint` about the adb server, prefix every `adb` command that you run yourself, as the hint shows.
2. **Boot if needed**: if no such emulator is ready, call `boot-device` with `avdName: <name>` from the same call's `avds` list.

## 3. Using the device

Pass the Android serial as `udid` to the same interaction tools as on iOS. See `argent-device-interact` for interaction tooling and the Android notes at the bottom of that skill. If a React Native app can't reach Metro, see `argent-metro-debugger` §1.

## 4. Notes

- **Android TV / leanback AVDs** boot through this exact flow, but `list-devices` tags them `runtimeKind: "tv"` and they are focus-driven: use the `argent-tv-interact` skill, not the gesture tools.
- To stop the emulator, run `adb -s <serial> emu kill` from a shell (clean shutdown). Never `pkill -9`/`kill -9` qemu: a hard kill leaves the userdata image dirty, after which cold boots can hang for many minutes doing recovery (runaway writes, `boot_completed` never flips). If an image gets into that state, boot once with `-wipe-data` to reset it.
