---
name: argent-tv-setup
description: Set up and connect to a TV target (Apple TV / tvOS simulator or Android TV / leanback emulator) using argent MCP tools. Use when starting a session on a TV device, booting an Apple TV simulator or Android TV emulator, getting a TV target id, or before any TV interaction task.
---

## The TV target model

argent drives both **Apple TV (tvOS)** and **Android TV (leanback)** with the same `tv-*` tools. A TV target is identified the same way on both platforms: `list-devices` tags it `runtimeKind: "tv"` (non-TV devices are `runtimeKind: "mobile"`). The id you pass differs by platform — an iOS-shaped UDID for Apple TV, an adb serial for Android TV — but you do NOT need to tell the tools which platform; dispatch is automatic from the id.

If you delegate device tasks to sub-agents, make sure they have MCP permissions.

## 1. Apple TV (tvOS simulator)

1. **Find a booted Apple TV simulator** — call `list-devices`, filter for `runtimeKind: "tv"` entries with an iOS-shaped UDID (booted devices are listed first). If none are booted, call `boot-device` with `udid: <chosen UDID>`.
2. **Verify connection** — the `tv-*` tools auto-start the tvOS daemons (`tvos-ax-service`, `tvos-hid-daemon`) on first use; no manual server start needed. The first call may take a few seconds while they spawn.

Notes:
- tvOS UDIDs look like `A1B2C3D4-E5F6-7890-ABCD-EF1234567890` (same shape as iOS — only `runtimeKind` distinguishes them).
- Passing an iPhone (`runtimeKind: "mobile"`) UDID to a `tv-*` tool fails with a clear "tvOS-only" error.

## 2. Android TV (leanback emulator)

1. **Boot a leanback AVD** the same way as any Android emulator — see `argent-android-emulator-setup` (`boot-device` with `avdName: <name>`). Its serial (`emulator-NNNN`) looks just like a phone emulator's.
2. **Identify it** — `list-devices` tags it `runtimeKind: "tv"`, detected via the system feature list (`android.software.leanback` / `android.hardware.type.television`), **not** the serial and **not** `ro.build.characteristics` (which reads `emulator` on TV AVD images). Pass the **serial** to the `tv-*` tools.
3. **No connection step** — the Android TV backend is adb-backed and starts no daemons, so there's nothing to wait on after boot.

Notes:
- `launch-app` automatically resolves the app's `LEANBACK_LAUNCHER` activity on a TV target, so launching an Android TV app needs no special `activity` argument.
- If a booted leanback AVD shows up as `runtimeKind: "mobile"`, that's a detection bug — flag it.

## 3. Connecting a dev build to Metro

A release build runs a baked-in bundle and needs no Metro. A **dev build** (Expo dev-client / `react-native-tvos` debug) boots into a dev-launcher and must be pointed at a running Metro before the real app UI appears — `launch-app` alone lands you on the launcher, not the app.

**Apple TV (tvOS simulator)** — load the bundle with a deep link via `open-url`:

```
open-url { udid: "<UDID>", url: "<scheme>://expo-development-client/?url=http%3A%2F%2F<HOST_IP>%3A8081" }
```

`<HOST_IP>` is your Mac's LAN IP (it changes between networks — read it off the dev-launcher screen, or check Metro). The dev-launcher also lists recently-used servers, which you can focus and `select` with the `tv-*` tools.

**Android TV (leanback emulator)** — `launch-app` brings up the Expo DevLauncher every time. Two ways to load the bundle:

1. Focus the "Recently Opened" server row and `select` it (use `tv-describe` to find it), **or**
2. Deep-link via adb (Metro reachable at the emulator alias `10.0.2.2`):
   ```
   adb -s <serial> shell am start -a android.intent.action.VIEW \
     -d "<pkg>://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" <pkg>
   ```

> **Android TV dev-menu trap:** the in-app developer menu overlay appears on first bundle load. Dismiss it with `adb shell input keyevent KEYCODE_DPAD_CENTER` — **not** the back button, which exits the app entirely.

After the bundle loads, give the RN JS a few seconds to render before the first `tv-describe` (focus only exists once the bundle has run — see `argent-tv-interact`).

## 4. Both platforms

A TV UI is **focus-driven**, not touch-driven. None of the coordinate/touch interaction tools (`gesture-tap`, `gesture-swipe`, `button`, `keyboard`, etc.) are the right tool on a TV target — use the `tv-*` tools instead. See `argent-tv-interact` for the full focus-driven interaction workflow (it covers both Apple TV and Android TV).
