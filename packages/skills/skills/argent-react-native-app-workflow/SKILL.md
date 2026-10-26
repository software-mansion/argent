---
name: argent-react-native-app-workflow
description: Step-by-step workflows for developing or debugging React Native apps on iOS simulator or Android emulator. Use when starting the app, debugging Metro, fixing builds, diagnosing runtime errors, or running tests.
---

Physical iPhone (`kind: "device"`): Metro debugging and profiling tools reject it. Use a simulator.

## 1. Starting the React Native App

### 1.1 Read the project's configuration first

**Before running commands**, read the project's build and run setup: every `package.json` script (custom scripts such as `start:local`, `start:dev`, `ios`, `build:ios` or flavors take priority over the defaults) and `metro.config.js` (a non-default port or `watchFolders`). Do NOT default to `npx react-native start` or `npx react-native run-ios` without checking. Before the first build, install dependencies if `node_modules` or `ios/Pods` is missing.

**If the project structure is convoluted, ask the user before proceeding.**

Once you know how the project starts Metro, builds and runs the app, and what environment setup it needs, **save that to project memory** so you don't need to rediscover it each time.

### 1.2 Start Metro

1. If Metro is already running on the project's port, do not start another (§2).
2. Start it in the background with the project's start script (e.g. `npm run start:local`, `yarn start:dev`), or `npx react-native start` when there is none.
3. Verify with `debugger-status`: `status: "connected"` or `reason: "no_app_connected"` both mean Metro is up (the app just hasn't attached yet); `reason: "metro_not_running"` means Metro is not reachable.

### 1.3 Run the App

Start the app only once Metro is ready, from the project root. Use the project's build/run script if one exists (e.g. `npm run ios`, `npm run android`, `yarn ios:debug`); fall back to the defaults below only if there is none.

**Pass the target device explicitly**, taken from `list-devices`: use the platform the user named, and do not pick a cabled physical phone just because it is listed. If the device isn't booted yet, boot it with `boot-device` (see `argent-ios-simulator-setup` / `argent-android-emulator-setup`).

```bash
npx react-native run-ios --simulator="<name>"        # iOS (or --udid <UDID>)
npx react-native run-android --deviceId=<adb-serial> # Android
```

**Android only**: after install, run `adb -s <serial> reverse tcp:8081 tcp:8081` so the emulator/device can reach Metro on your host. Repeat if the device restarts or adb drops. If `list-devices` returns a `hint` about the adb server, prefix this and every other `adb` command that you run yourself, as the hint shows.

---

## 2. Metro Already on the Port?

The default port is 8081 unless the project configures another. Check it with `lsof -i :<port>`. If something is listening, `debugger-status` tells you whether it is Metro: `status: "connected"` or `reason: "no_app_connected"` means it is. `reason: "metro_not_running"` while `lsof` shows a listener means the port is held by something that is **not** Metro; the result's `detail` shows what answered (`... (got: ...)`). In that case ask the user whether you may kill the process.

To stop a Metro process, use the `stop-metro` tool.

---

## 3. Build, Reload, Reinstall

| Situation                                     | Action                                                           |
| --------------------------------------------- | ---------------------------------------------------------------- |
| JS/React only changed                         | `debugger-reload-metro`, or `restart-app`. No rebuild.           |
| Native code, pods or project config changed   | Rebuild with the project's run command (Metro can stay running). |
| App needs reinstalling from a `.app` / `.apk` | `reinstall-app`.                                                 |

When a build fails (e.g. xcodebuild exit code 65), try the simplest fix first: clean the build folder and retry, then clear caches and reinstall dependencies and pods.

**After 2-3 failed build or run attempts, STOP and ask the user for guidance.** The user may know about required env vars, Xcode version requirements, custom build configurations, monorepo-specific setup, or required external services. If the correct build approach is not obvious, **ask the user early** rather than guessing.

---

## 4. Runtime Problems in the App

| Problem type                      | Where to look                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **JavaScript errors / logs**      | `debugger-log-registry` for a summary and the log file path, then `Grep` the file                          |
| **React component hierarchy**     | `debugger-component-tree`, or `debugger-inspect-element` at logical pixel coordinates (not normalized 0-1) |
| **App state**                     | `debugger-evaluate` to run JavaScript in the app's runtime                                                 |
| **Native crashes / native stack** | `npx react-native log-ios` / `npx react-native log-android`, or `adb -s <serial> logcat`                   |

For connection failures, component inspection and searching the console log file, use the `argent-metro-debugger` skill.

Do not open the React Native DevMenu by default; use the argent tools instead.

---

## 5. Testing the App

Ask the user before running tests: which suite (unit, E2E, or both), whether to use existing CI commands, and whether they want you to run existing tests, write new ones, or explore test cases yourself. Find the test commands in `package.json` and the test config (Jest, Detox, …).

For interactive UI testing with screenshot verification after each action, use the `argent-test-ui-flow` skill. For visible UI changes, follow the `argent-screenshot-diff` skill when stable before/after screenshots add meaningful pixel-visible evidence.
