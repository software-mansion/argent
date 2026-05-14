---
name: argent-react-native-app-workflow
description: Step-by-step workflows for developing or debugging React Native apps on iOS simulator or Android emulator. Use when starting the app, debugging Metro, fixing builds, diagnosing runtime errors, or running tests.
---

## 1. Starting the React Native App

### 1.1 Explore Configuration (MANDATORY — Do This First)

**Before running commands**, read the project's build and run configuration from the `argent-environment-inspector` subagent result.

Do NOT default to `npx react-native start` or `npx react-native run-ios` without first checking for custom scripts and workflows.

**Manual fallback** (if neither the agent nor the tool is available): read ALL `package.json` scripts — look for custom scripts like `start:local`, `start:dev`, `ios`, `android`, `build:ios`, `build:android`, flavors, etc. Custom scripts take priority over default commands. Also check `metro.config.js` for non-default port or watchFolders. Platform-specific notes:

- **iOS**: prefer opening `.xcworkspace` over `.xcodeproj` (CocoaPods generates the workspace).
- **Android**: build entry is `android/gradlew` (Unix) or `gradlew.bat` (Windows). Open `android/` in Android Studio for detailed errors. Check `android/app/build.gradle` (or `build.gradle.kts`) for `applicationId`, flavors, and signing config.

**If the project structure is convoluted, ask the user before proceeding.**

**Remember the workflow:** Once you discover the project's build/run workflow, save it to project memory so you don't need to re-discover it each time.

**Checklist before start:**

- [ ] `node_modules` present (if not: `npm install` or `yarn`)
- [ ] For iOS: `ios/Podfile` exists; if `ios/Pods` missing or stale, run `cd ios && pod install && cd ..`
- [ ] For Android: `android/gradlew` exists and is executable. A first run may need `cd android && ./gradlew --version` to warm the Gradle wrapper.
- [ ] No conflicting Metro on default port (see 1.2)

### 1.2 Start Metro

1. Check whether metro is already running on port found in configuration and if it is - do not start another server. Refer to point 2.1.

1. **Use the project's custom start script if one exists** (e.g. `npm run start:local`, `yarn start:dev`). Fall back to default commands if no custom scripts are defined:

   ```bash
   npx react-native start
   ```

   Optional: `npx react-native start --reset-cache` if cache issues are suspected.

1. **Verify Metro is ready**: use the `debugger-status` tool to verify Metro is running and reachable.

1. **Projects with flavors or custom configs**: Use project-specific start script if present (e.g. `npm run start:local`), and start Metro **before** running the app.

### 1.3 Run the App

In a **separate** terminal (Metro keeps running in the first):

**Use the project's custom build/run script if one exists** (e.g. `npm run ios`, `npm run android`, `yarn ios:debug`). Only fall back to the default if no custom scripts are defined:

```bash
npx react-native run-ios       # iOS
npx react-native run-android   # Android
```

Optional: specify the target device, e.g. `npx react-native run-ios --simulator="iPhone 16"` or `npx react-native run-android --deviceId=<serial>`.

**Android only**: after install, run `adb -s <serial> reverse tcp:8081 tcp:8081` so the emulator/device can reach Metro on your host. Repeat if the device restarts or adb drops.

**Agent checklist:**

- [ ] Metro is already running and shows "ready"
- [ ] Command run from project root
- [ ] If the device isn't booted: use `boot-device` with the iOS `udid` or Android `avdName`. Refer to the `argent-ios-simulator-setup` / `argent-android-emulator-setup` skill.
- [ ] Android: `adb -s <serial> reverse tcp:8081 tcp:8081` done.

---

## 2. Ensuring / Debugging Metro

### 2.1 Check for Existing Metro

Before starting Metro, avoid "port already in use" errors. Default port to check is :8081, infer the port from documentation:

```bash
lsof -i :PORT
```

- **No output** → Port free; safe to start Metro.
- **Output with PID** → Another process is using the port.

Use the `debugger-status` tool to check whether the process on that port is actually a Metro server. If not Metro — ask the user whether you may kill the process.

To kill a Metro process, use the `stop-metro` tool (requires user confirmation).

### 2.2 Confirm Correct Server Connection

- **App must point at the same host/port as the running Metro.** Default: same machine, port 8081.
- **iOS Simulator:** by default uses localhost; no extra config needed for same-machine Metro.
- **Android emulator / device:** Metro is **not** auto-reachable. Before the app starts, run `adb -s <serial> reverse tcp:8081 tcp:8081` so the device can reach Metro on `localhost`. Re-run if the device restarts or adb drops.

**Verify Metro is reachable:** use the `debugger-status` tool.

### 2.3 Reload the App (Ensure New Bundle)

After code or config changes, the app must load the new bundle:

| Method      | How                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reload tool | Use the `debugger-reload-metro` tool (works on both iOS and Android)                                                                                                                                 |
| Restart app | Use the `restart-app` tool, or kill the app on the device and re-run the platform build command (`npx react-native run-ios` on iOS, `npx react-native run-android` on Android, or the custom script) |

**Agent checklist:**

- [ ] Only one Metro process (no duplicate on port)
- [ ] App was started after Metro was ready
- [ ] When needing to reload: refer to 2.3

---

## 3. Build / Install / Retry (React Native — iOS & Android native)

### 3.1 When Build Fails

**Order of operations (simplest first):**

1. Clean build folder, then retry the build command (iOS: `cd ios && xcodebuild clean` or Xcode → Product → Clean; Android: `cd android && ./gradlew clean`).
2. Clear caches and reinstall JS dependencies: reset Metro cache (`npx react-native start --reset-cache`), `watchman watch-del-all`, remove `node_modules` + lockfile, `npm install` (or `yarn`).
3. **iOS-specific** (when `xcodebuild` fails, e.g. exit code 65):
   - `cd ios && rm -rf build Pods Podfile.lock && pod install --repo-update`
   - CocoaPods deeper issues: `pod deintegrate` then `pod install --repo-update`
   - Open `ios/*.xcworkspace` in Xcode for detailed errors in the Report navigator
4. **Android-specific** (when `gradlew` fails, e.g. exit code 1):
   - `cd android && ./gradlew clean` then re-run the build
   - Stale daemon / cache: `cd android && ./gradlew --stop`, optionally `rm -rf ~/.gradle/caches/` (heavy — only when corruption is suspected)
   - Missing dependency: confirm `android/build.gradle` repositories and SDK levels match the target; check `local.properties` for `sdk.dir`
   - Open `android/` in Android Studio for the full error log and Gradle console

### 3.2 When to Ask the User

**After 2-3 failed build or run attempts, STOP and ask the user for guidance.** The user may know about required env vars, Xcode version requirements, custom build configurations, monorepo-specific setup, or required external services.

If the project structure is convoluted and the correct build approach is not obvious, **ask the user early** rather than guessing.

### 3.3 Saving Build Workflow for Later

Once you discover the correct build/run workflow for a project, **save it to project memory**. Capture: commands to start Metro, commands to build/run the app, and any required environment setup.

### 3.4 When to Reinstall vs Refresh

| Situation                                             | Action                                                                                                                                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS/React only changed                                 | Use `debugger-reload-metro` tool. No rebuild.                                                                                                                                                  |
| Native code or `pod install` / project config changed | Rebuild for the target platform: `npx react-native run-ios` (iOS) or `npx react-native run-android` (Android). Metro can stay running.                                                         |
| `node_modules` or `package.json` changed              | `npm install`, then if native deps changed run `cd ios && pod install` (iOS) and/or refresh the Android Gradle wrapper (`cd android && ./gradlew :app:dependencies` will fetch). Then rebuild. |
| App needs reinstalling from build output              | Use `reinstall-app` tool with device id, bundle id / package name, and the bundle path (`.app` for iOS, `.apk` for Android).                                                                   |
| Persistent native build errors                        | Full clean + reinstall (step 2 above).                                                                                                                                                         |

### 3.5 Device Control

| Action                     | Tool / Command                                                         |
| -------------------------- | ---------------------------------------------------------------------- |
| List devices               | `list-devices` tool (iOS + Android)                                    |
| Boot an iOS simulator      | `boot-device` tool with `udid`                                         |
| Boot an Android emulator   | `boot-device` tool with `avdName`                                      |
| Launch an app              | `launch-app` tool (pass device id + bundle id / package name)          |
| Restart an app             | `restart-app` tool (pass device id + bundle id / package name)         |
| Open a URL / deep link     | `open-url` tool (pass device id + URL)                                 |
| Rotate device              | `rotate` tool                                                          |
| Stop simulator server      | `stop-simulator-server` tool (iOS UDID or Android serial — one device) |
| Stop all simulator servers | `stop-all-simulator-servers` tool (iOS + Android)                      |

For full device setup workflow, refer to the `argent-ios-simulator-setup` skill (iOS) or the `argent-android-emulator-setup` skill (Android).

---

## 4. Runtime Problems in the App

### 4.1 Where to Look

| Problem type                      | Tool / Where to look                                                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **JavaScript errors / logs**      | Use `debugger-log-registry` to get a summary and log file path, then `Grep`/`Read` to search.                                                                                                                                                                     |
| **React component hierarchy**     | Use `debugger-component-tree` tool for a text tree, or `debugger-inspect-element` at specific logical pixel coordinates (not normalized 0-1).                                                                                                                     |
| **Visual state of the app**       | Use `screenshot` tool to capture the current screen, but prefer `describe` or `debugger-component-tree` for actual navigation and target discovery. If a permission prompt or system-owned modal overlay is not exposed reliably, then fall back to `screenshot`. |
| **Evaluate JS in the app**        | Use `debugger-evaluate` tool to run JavaScript in the app's runtime.                                                                                                                                                                                              |
| **Native crashes / native stack** | iOS: `npx react-native log-ios` or iOS Simulator: Debug → Open System Log. Android: `npx react-native log-android` or `adb -s <serial> logcat` (filter by tag/PID).                                                                                               |
| **Build/runtime config**          | `metro.config.js`, `babel.config.js`, `package.json` scripts. iOS: `ios/Podfile`, `ios/*.xcworkspace`. Android: `android/build.gradle`, `android/app/build.gradle`, `android/gradle.properties`, `android/local.properties`.                                      |

For comprehensive Metro debugging workflows (component inspection, console logs, JS evaluation), refer to the `argent-metro-debugger` skill.

### 4.2 JS Console Logs (Log Registry)

Logs are written to a flat log file on disk under `~/.argent/tmp/`. Use the **log-registry → grep** pattern instead of reading logs inline.

For the full workflow, flat entry format, and grep examples, see `argent-metro-debugger` skill §5.

### 4.3 Do not try to use the DevMenu in React Native apps by default.

Use the argent tools instead.

---

## 5. Testing the App

Check the `argent-environment-inspector` result for test commands. For interactive UI testing with automatic screenshot verification, use the `argent-test-ui-flow` skill.

- **Unit tests**: Look for Jest in `package.json` (`"test": "jest"`, `jest` config). Run: `npm test` or `yarn test`.
- **E2E**: Look for Detox (`.detoxrc.js` or similar), or other E2E config. Dependencies: `detox`, `detox-cli`. iOS often also needs `applesimutils`. Android Detox needs an AVD configured in `.detoxrc` and `adb` on PATH.
- **UI flow testing**: For interactive UI testing with automatic screenshot verification, refer to the `argent-test-ui-flow` skill.

### 5.2 Running Tests (Typical)

If the user's intent is ambiguous (run existing tests, write new tests, or find missing coverage), clarify before proceeding.

- **Jest**: `npm test` or `npx jest`.
- **Detox** (configuration names are project-specific — check `.detoxrc.js` for available `configurations`):
  - iOS: `detox build --configuration ios.sim.release` (or debug) then `detox test --configuration ios.sim.release`. Ensure the iOS simulator is booted and not used by another process.
  - Android: `detox build --configuration android.emu.release` (or debug) then `detox test --configuration android.emu.release`. Ensure the AVD is running and `adb devices` lists it.

### 5.3 Agent Testing Checklist

- [ ] Read `package.json` and test config (Jest, Detox, etc.).
- [ ] If E2E: confirm simulator/device and build config.
- [ ] If unclear: clarify whether to use existing workflows or write new tests.

---

## Quick Reference: Tools & Commands

| Goal                         | Tool / Command                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Check port 8081              | `lsof -i :8081`                                                                                                                          |
| Kill Metro                   | `stop-metro` tool                                                                                                                        |
| Start Metro                  | `npx react-native start`                                                                                                                 |
| Start Metro (reset cache)    | `npx react-native start --reset-cache`                                                                                                   |
| Run iOS app                  | `npx react-native run-ios`                                                                                                               |
| Run Android app              | `npx react-native run-android`                                                                                                           |
| Android: Metro reverse-port  | `adb -s <serial> reverse tcp:8081 tcp:8081` (after device boot, before app start)                                                        |
| List devices                 | `list-devices` tool (iOS + Android)                                                                                                      |
| Boot a device                | `boot-device` tool (pass `udid` for iOS or `avdName` for Android)                                                                        |
| Take screenshot              | `screenshot` tool                                                                                                                        |
| Describe screen (a11y tree)  | `describe` tool for normal app screens and in-app modals; use `screenshot` only when permission/system overlays are not exposed reliably |
| Read JS console logs         | `debugger-log-registry` tool                                                                                                             |
| Reload JS bundle             | `debugger-reload-metro` tool                                                                                                             |
| Check Metro status           | `debugger-status` tool                                                                                                                   |
| Inspect React component tree | `debugger-component-tree` tool                                                                                                           |
| Run JS in app                | `debugger-evaluate` tool                                                                                                                 |
| iOS native logs              | `npx react-native log-ios`                                                                                                               |
| Android native logs          | `npx react-native log-android` or `adb -s <serial> logcat`                                                                               |
| Android: stop emulator       | `adb -s <serial> emu kill`                                                                                                               |
| Clean + reinstall (nuclear)  | See §3.1 step 3 (iOS) or §3.1 step 4 (Android)                                                                                           |

---

## Related Skills

| Skill                           | When to use                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `argent-ios-simulator-setup`    | Initial iOS simulator boot and connection setup                                         |
| `argent-android-emulator-setup` | Initial Android emulator boot, AVD selection, `adb reverse` setup                       |
| `argent-device-interact`        | Tapping, swiping, typing, hardware buttons, gestures (iOS simulator + Android emulator) |
| `argent-metro-debugger`         | Full Metro CDP debugging: component inspection, console logs, JS evaluation             |
| `argent-react-native-profiler`  | Profiling performance, finding re-render issues, CPU hotspots                           |
| `argent-test-ui-flow`           | Interactive UI testing with automatic screenshot verification after each action         |

Ask the user before running tests: confirm which test suite (unit, E2E, or both), whether to use existing CI commands, and whether they want you to run existing tests, write new ones, or explore test cases yourself.
