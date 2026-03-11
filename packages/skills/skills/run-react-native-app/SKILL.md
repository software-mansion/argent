---
name: react-native-ios-autonomous-dev
description: Step-by-step workflows for developing or debugging React Native apps with iOS simulator. Use when starting the app, debugging Metro, fixing builds, diagnosing runtime errors, or running tests.
---

## 1. Starting the React Native App

### 1.1 Explore Configuration

Before starting, gather project context:

| Action                | Command / Location                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Check if React Native | Check for `package.json` with `react-native` dependency; look for `index.js` or `App.js` at root.                                       |
| Metro config          | Read `metro.config.js` (or `metro.config.json`, or `metro` in `package.json`). Default RN projects extend `@react-native/metro-config`. |
| Scripts               | In `package.json`: `start`, `run-ios`, `run-android`. Note any custom scripts (e.g. `start:local`, flavors).                            |
| iOS entry             | `ios/` folder with `.xcworkspace` (CocoaPods) or `.xcodeproj`. Prefer opening `.xcworkspace` for builds.                                |

**Checklist before start:**

- [ ] `node_modules` present (if not: `npm install` or `yarn`)
- [ ] For iOS: `ios/Podfile` exists; if `ios/Pods` missing or stale, run `cd ios && pod install && cd ..`
- [ ] No conflicting Metro on default port (see 1.2)

### 1.2 Start Metro

1. Check whether metro is already running on port found in configuration and if it is - do not start another server. Refer to point 2.1.

1. **Prefer starting Metro explicitly** (more reliable than relying on auto-start from `run-ios`):

   ```bash
   npx react-native start
   ```

   Optional: `npx react-native start --reset-cache` if cache issues are suspected.

1. **Verify Metro is ready**: use the `debugger-status` tool to verify Metro is running and reachable.

1. **Projects with flavors or custom configs**: Use project-specific start script if present (e.g. `npm run start:local`), and start Metro **before** running the app.

### 1.3 Run the iOS App

In a **separate** terminal (Metro keeps running in the first):

```bash
npx react-native run-ios
```

Optional: specify device or simulator, e.g. `npx react-native run-ios --simulator="iPhone 16"`.

**Agent checklist:**

- [ ] Metro is already running and shows "ready"
- [ ] Command run from project root
- [ ] If simulator not booted: use the `boot-simulator` tool with proper UUID. Refer to the `simulator-setup` skill.

---

## 2. Ensuring / Debugging Metro

### 2.1 Check for Existing Metro (Port 8081)

Before starting Metro, avoid "port already in use" errors. Default port to check is :8081, you should infer the port from documentation:

```bash
lsof -i :PORT
```

- **No output** → Port free; safe to start Metro.
- **Output with PID** → Another process (often Metro instance started by user) is using the port.

Use the `debugger-status` tool to check whether the process on that port is actually a Metro server. If the app running on the port is not Metro - ask the user whether you may kill the process.

To kill a Metro process, use the `stop-metro` tool (requires user confirmation).

### 2.2 Confirm Correct Server Connection

- **App must point at the same host/port as the running Metro.** Default: same machine, port 8081.
- **Physical device:** Ensure device and dev machine on same network; reverse port if needed (e.g. Android: `adb reverse tcp:8081 tcp:8081`).
- **iOS Simulator:** By default uses localhost; no extra config needed for same-machine Metro.

**Verify Metro is reachable:** use the `debugger-status` tool, or curl `http://localhost:PORT` and expect Metro's debug page or JSON.

### 2.3 Reload the App (Ensure New Bundle)

After code or config changes, the app must load the new bundle:

| Method       | How                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------- |
| Reload tool  | Use the `debugger-reload-metro` tool                                                              |
| Restart app  | Use the `restart-app` tool, or kill the app in simulator and run `npx react-native run-ios` again |

**Agent checklist:**

- [ ] Only one Metro process (no duplicate on 8081)
- [ ] App was started after Metro was ready
- [ ] When needing to reload: refer to 2.3

---

## 3. Build / Install / Retry (React Native & iOS Native)

### 3.1 When Build Fails (e.g. xcodebuild exit code 65)

**Order of operations (simplest first):**

1. **Clean build**
   - Xcode: Product → Clean Build Folder.
   - CLI: `cd ios && xcodebuild clean && cd ..` (or remove `ios/build` and optionally `~/Library/Developer/Xcode/DerivedData/<app>` if needed).

2. **Retry**

   ```bash
   npx react-native run-ios
   ```

3. **Clear caches and reinstall JS + native deps**

   ```bash
   npx react-native start -- --reset-cache   # then stop it
   watchman watch-del-all                    # if watchman installed
   rm -rf node_modules package-lock.json yarn.lock
   npm install
   cd ios && rm -rf build Pods Podfile.lock && pod install --repo-update && cd ..
   npx react-native run-ios
   ```

4. **CocoaPods issues**

   ```bash
   cd ios
   pod deintegrate
   pod install --repo-update
   cd ..
   ```

5. **Open in Xcode for detailed errors**: Open `ios/*.xcworkspace` in Xcode and build from there; read the full error in the Report navigator.

### 3.2 When to Reinstall vs Refresh

| Situation                                             | Action                                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| JS/React only changed                                 | Use `debugger-reload-metro` tool. No rebuild.                                                            |
| Native code or `pod install` / project config changed | Rebuild: `npx react-native run-ios` (Metro can stay running).                                            |
| `node_modules` or `package.json` changed              | `npm install`, then if native deps changed run `cd ios && pod install`. Then rebuild.                    |
| App needs reinstalling from .app path                 | Use `reinstall-app` tool with bundle ID and .app path.                                                   |
| Persistent native build errors                        | Full clean + reinstall (step 3 above).                                                                   |

### 3.3 iOS Simulator Control

| Action                    | Tool / Command                                                            |
| ------------------------- | ------------------------------------------------------------------------- |
| List devices              | `list-simulators` tool                                                    |
| Boot a simulator          | `boot-simulator` tool (pass UDID)                                        |
| Launch an app             | `launch-app` tool (pass bundle ID)                                       |
| Restart an app            | `restart-app` tool (terminate + relaunch by bundle ID)                    |
| Open a URL / deep link    | `open-url` tool                                                          |
| Rotate simulator          | `rotate` tool                                                            |
| Stop simulator server     | `stop-simulator-server` tool (for a specific UDID)                       |
| Stop all simulator servers| `stop-all-simulator-servers` tool                                        |
| Shutdown simulator        | `xcrun simctl shutdown <UDID>`                                           |

For full simulator setup workflow, refer to the `simulator-setup` skill.

---

## 4. Runtime Problems in the App

### 4.1 Where to Look

| Problem type                      | Tool / Where to look                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **JavaScript errors / logs**      | Use `debugger-console-logs` tool to read captured logs, or `debugger-console-listen` for real-time logs.   |
| **React component hierarchy**     | Use `debugger-component-tree` tool for a text tree, or `debugger-inspect-element` at specific coordinates. |
| **Visual state of the app**       | Use `screenshot` tool to capture the current screen, or `describe` tool for the accessibility element tree.|
| **Evaluate JS in the app**        | Use `debugger-evaluate` tool to run JavaScript in the app's runtime.                                      |
| **Native crashes / native stack** | `npx react-native log-ios` or iOS Simulator: Debug → Open System Log.                                    |
| **Build/runtime config**          | `metro.config.js`, `babel.config.js`, `package.json` scripts, `ios/Podfile`.                              |

For comprehensive Metro debugging workflows (breakpoints, stepping, pausing), refer to the `metro-debugger` skill.

### 4.2 Dev Menu (iOS Simulator)

- Open: **Cmd+Ctrl+Z** (or Cmd+D depending on setup).
- Use for: Reload, Debug with Chrome/DevTools, Enable Fast Refresh, Inspect Element.

### 4.3 Logs

| Log type        | Tool / Command                                                                                |
| --------------- | --------------------------------------------------------------------------------------------- |
| JS console logs | `debugger-console-logs` tool (captured logs) or `debugger-console-listen` tool (real-time)     |
| iOS native logs | `npx react-native log-ios` or Xcode console when running from Xcode                          |

### 4.4 Debugging with Breakpoints

For stepping through code with breakpoints, use the debugger tools:

1. Connect to Metro: `debugger-connect` tool
2. Set breakpoint: `debugger-set-breakpoint` tool (file + line)
3. When paused: `debugger-step` tool (over/into/out), inspect with `debugger-evaluate`
4. Resume: `debugger-resume` tool
5. Remove breakpoint: `debugger-remove-breakpoint` tool

For the full debugging workflow, refer to the `metro-debugger` skill.

---

## 5. Testing the App

### 5.1 Check Existing Test Config

- **Unit tests**: Look for Jest in `package.json` (`"test": "jest"`, `jest` config). Run: `npm test` or `yarn test`.
- **E2E**: Look for Detox (`.detoxrc.js` or similar), or other E2E config. Dependencies: `detox`, `detox-cli`, and for iOS often `applesimutils`.
- **UI flow testing**: For interactive UI testing with automatic screenshot verification, refer to the `test-ui-flow` skill.

### 5.2 Ask User When Appropriate

- **Which test suite to run** (unit only, E2E only, or both).
- **Use existing CI/config** (e.g. "Should I use the same command you use in CI?").
- **Simulator/device** for E2E (e.g. "Use iPhone 16 in Detox?").

### 5.3 Running Tests (Typical)

Ask the use whether he wants you to run the test manually, come up with you own tests, try to find new test cases.

ONLY IF ASKED to run existing tests:
- **Jest**: `npm test` or `npx jest`.
- **Detox (example)**:
  - Build: `detox build --configuration ios.sim.release` (or debug).
  - Run: `detox test --configuration ios.sim.release`.
  - Ensure simulator is booted and not used by another process.

### 5.4 Agent Testing Checklist

- [ ] Read `package.json` and test config (Jest, Detox, etc.).
- [ ] If E2E: confirm simulator/device and build config.
- [ ] If unclear: ask whether to use existing workflows or test manually by yourself

---

## Quick Reference: Tools & Commands

| Goal                          | Tool / Command                                 |
| ----------------------------- | ---------------------------------------------- |
| Check port 8081               | `lsof -i :8081`                                |
| Kill Metro                    | `stop-metro` tool                              |
| Start Metro                   | `npx react-native start`                       |
| Start Metro (reset cache)     | `npx react-native start --reset-cache`         |
| Run iOS app                   | `npx react-native run-ios`                     |
| List simulators               | `list-simulators` tool                         |
| Boot simulator                | `boot-simulator` tool                          |
| Take screenshot               | `screenshot` tool                              |
| Describe screen (a11y tree)   | `describe` tool                                |
| Read JS console logs          | `debugger-console-logs` tool                   |
| Reload JS bundle              | `debugger-reload-metro` tool                   |
| Check Metro status            | `debugger-status` tool                         |
| Inspect React component tree  | `debugger-component-tree` tool                 |
| Run JS in app                 | `debugger-evaluate` tool                       |
| iOS native logs               | `npx react-native log-ios`                     |
| Clean + reinstall (nuclear)   | See §3.1 step 3                                |

---

## Related Skills

| Skill                    | When to use                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ |
| `simulator-setup`        | Initial simulator boot and connection setup                                    |
| `simulator-interact`     | Tapping, swiping, typing, hardware buttons, gestures on the simulator          |
| `simulator-screenshot`   | Capturing screenshots of the simulator screen                                  |
| `metro-debugger`         | Full Metro CDP debugging: breakpoints, stepping, component inspection          |
| `react-native-profiler`  | Profiling performance, finding re-render issues, CPU hotspots                  |
| `test-ui-flow`           | Interactive UI testing with automatic screenshot verification after each action |
