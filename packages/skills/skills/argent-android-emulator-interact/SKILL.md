---
name: argent-android-emulator-interact
description: Android-specific notes for interacting with the UI. Use alongside `argent-simulator-interact` — the core interaction tools (tap/swipe/type/describe/...) are unified and auto-dispatch by device id.
---

## Unified tool surface

The interaction tools are the same on iOS and Android. Pass the Android adb `serial` (e.g. `emulator-5554`) as `udid` and the tool auto-dispatches.

Use these tools directly — no `android-*` prefix:

| Tool             | Works on      | Notes                                                                                                                |
| ---------------- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| `gesture-tap`    | iOS + Android | Simulator-server WebSocket on both platforms                                                                         |
| `gesture-swipe`  | iOS + Android |                                                                                                                      |
| `gesture-custom` | iOS + Android | Multi-touch via simulator-server — long-press / drag / arbitrary sequences                                           |
| `gesture-pinch`  | iOS + Android | True two-finger pinch-to-zoom on both platforms                                                                      |
| `gesture-rotate` | iOS + Android | Two-finger rotation. For device orientation use the `rotate` tool                                                    |
| `button`         | iOS + Android | home, back, power, volumeUp, volumeDown, appSwitch, actionButton — the binary maps to each platform's native keycode |
| `keyboard`       | iOS + Android | USB HID keycodes routed through simulator-server; binary maps internally                                             |
| `rotate`         | iOS + Android |                                                                                                                      |
| `screenshot`     | iOS + Android | Simulator-server HTTP → `http://` URL on both platforms                                                              |
| `describe`       | iOS + Android | iOS: AXRuntime → native-devtools fallback. Android: `uiautomator dump`                                               |
| `launch-app`     | iOS + Android | iOS: bundle id via simctl. Android: package name via `am start` / `monkey`. Optional `activity` on Android           |
| `restart-app`    | iOS + Android | Android: `am force-stop` + `monkey` relaunch                                                                         |
| `reinstall-app`  | iOS + Android | iOS: `.app`. Android: `.apk`. Android extras: `grantPermissions`, `allowDowngrade`                                   |
| `open-url`       | iOS + Android | Works for any scheme a registered app handles                                                                        |
| `run-sequence`   | iOS + Android | All gesture/button/keyboard/rotate tools allowed — works identically on both platforms                               |

For tool-by-tool usage see `argent-simulator-interact`.

## Android-only tools

These have no iOS equivalent and keep their `android-` prefix:

| Tool                     | Purpose                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `android-list-emulators` | List adb devices + available AVDs                                                        |
| `android-boot-emulator`  | Boot an AVD by name (cold boot by default; 2–5 min; clean failure if it doesn't come up) |
| `android-stop-app`       | `am force-stop` without relaunching                                                      |
| `android-logcat`         | Recent log lines. Filter by `bundleId`, `priority` (V/D/I/W/E/F), `tag`                  |

## Platform detection

The tool-server looks at the `udid` string:

- `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` → iOS simulator UDID
- `XXXXXXXX-XXXXXXXXXXXXXXXX` → iOS 17+ short form
- Anything else (e.g. `emulator-5554`, `R5CT12345678`) → Android adb serial

Pass iOS UDIDs from `list-simulators` and Android serials from `android-list-emulators`. Do not pass them to the wrong platform — dispatch is automatic.

## Android-specific gotchas

- **Metro reachability**: `adb -s <serial> reverse tcp:8081 tcp:8081` before the RN app starts, or Metro won't be reachable from the device. Re-run if the device restarts.
- **First-launch permission prompts**: pass `grantPermissions: true` to `reinstall-app` on Android so the app skips the runtime-permission dialogs.
- **Locked screen / secure surfaces**: `describe` throws a clear error if `uiautomator dump` can't capture (keyguard, DRM, Play Integrity). Unlock the device or fall back to `screenshot`.
- **APK vs .app in `reinstall-app`**: pass `.apk` absolute path on Android; `.app` directory on iOS. The tool dispatches based on `udid`.
