---
name: argent-android-emulator-setup
description: Boot an Android emulator and find its serial with Argent. Use only when no Android emulator is running yet or you need to pick and boot one.
---

## 1. Prerequisites

The Android SDK (platform tools and emulator) and an AVD, created in Android Studio or with `avdmanager create avd`. If `list-devices` returns no Android entries, either no AVD exists or Argent can't find the SDK. Then run `argent config set android.sdkRoot <sdk-path>` and call `list-devices` again after a minute: a failed SDK lookup is cached that long. Exporting `ANDROID_HOME` in your shell doesn't reach the tool-server that is already running.

## 2. Setup

1. **Find a ready device**: call `list-devices`. Filter for entries with `platform: "android"`. Ready devices (`state: "device"`) come first. If the user named a device, use it. Otherwise pick the first `kind: "emulator"` that fits the task. Take a physical phone (`kind: "device"`) only when the user asks for one. If the result's `notes` mention the adb server, prefix every `adb` command that you run yourself, as the note shows.
2. **Boot if needed**: if no such emulator is ready, call `boot-device` with the `avdName` of a `kind: "avd"` entry. It returns the serial; pass that serial as `udid` to argent tools. An `avd` entry doesn't mark TV images: for a TV task, pick the AVD by its name.

## 3. Using the device

Pass the Android serial as `udid` to the same interaction tools as on iOS. See `argent-device-interact` (and its `references/advanced.md` for Android notes). If a React Native app can't reach Metro, see `argent-metro-debugger` §1.

## 4. Notes

- **Android TV / leanback AVDs** boot through this exact flow, but once running `list-devices` tags them `runtimeKind: "tv"` and they are focus-driven: use the `argent-tv-interact` skill, not the gesture tools.
- To stop the emulator, run `adb -s <serial> emu kill` from a shell (clean shutdown). Never `pkill -9`/`kill -9` qemu: a hard kill leaves the userdata image dirty, after which cold boots can hang for many minutes doing recovery (runaway writes, `boot_completed` never flips). If an image gets into that state, boot once with `-wipe-data` to reset it.
