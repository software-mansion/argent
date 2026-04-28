---
name: argent-android-emulator-interact
description: Android-specific notes for interacting with the UI. Use when driving an Android emulator via the unified interaction tools (tap/swipe/type/describe/...) — pair with `argent-simulator-interact` for the cross-platform details.
---

Pass the Android adb `serial` (e.g. `emulator-5554`) as `udid` to the unified interaction tools (`gesture-tap`, `gesture-swipe`, `describe`, `screenshot`, `launch-app`, `keyboard`, etc.). Dispatch is automatic — see `argent-simulator-interact` for tool-by-tool usage.

## Android-specific gotchas

- **Metro reachability**: run `adb reverse tcp:8081 tcp:8081` on the device before the RN app starts, or Metro won't be reachable from the device. See `argent-metro-debugger` for the full workflow. Re-run if the device restarts.
- **First-launch permission prompts**: pass `grantPermissions: true` to `reinstall-app` on Android so the app skips the runtime-permission dialogs.
- **Locked screen / secure surfaces**: `describe` throws a clear error if it can't capture (keyguard, DRM, Play Integrity). Unlock the device or fall back to `screenshot`.
- **APK vs .app in `reinstall-app`**: pass `.apk` absolute path on Android; `.app` directory on iOS.
