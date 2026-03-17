---
name: react-native-app-workflow
description: Step-by-step workflows for developing or debugging React Native apps with iOS simulator. Use when starting the app, debugging Metro, fixing builds, diagnosing runtime errors, or running tests.
---

## 1. Starting the React Native App

### 1.1 Explore Configuration (MANDATORY — Do This First)

**Before running commands**, read the project's build and run configuration from the `environment-inspector` subagent result.

Do NOT default to `npx react-native start` or `npx react-native run-ios` without first checking for custom scripts and workflows.

**Manual fallback** (if neither the agent nor the tool is available): read ALL `package.json` scripts — look for custom scripts like `start:local`, `start:dev`, `ios`, `build:ios`, flavors, etc. Custom scripts take priority over default commands. Also check `metro.config.js` for non-default port or watchFolders. For iOS builds, prefer opening `.xcworkspace` over `.xcodeproj` (CocoaPods generates the workspace).

**If the project structure is convoluted, ask the user before proceeding.**

**Remember the workflow:** Once you discover the project's build/run workflow, save it to project memory so you don't need to re-discover it each time.

**Checklist before start:**

- [ ] `node_modules` present (if not: `npm install` or `yarn`)
- [ ] For iOS: `ios/Podfile` exists; if `ios/Pods` missing or stale, run `cd ios && pod install && cd ..`
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

### 1.3 Run the iOS App

In a **separate** terminal (Metro keeps running in the first):

**Use the project's custom build/run script if one exists** (e.g. `npm run ios`, `yarn ios:debug`). Only fall back to the default if no custom scripts are defined:

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
- **iOS Simulator:** By default uses localhost; no extra config needed for same-machine Metro.

**Verify Metro is reachable:** use the `debugger-status` tool.

### 2.3 Reload the App (Ensure New Bundle)

After code or config changes, the app must load the new bundle:

| Method      | How                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Reload tool | Use the `debugger-reload-metro` tool                                                              |
| Restart app | Use the `restart-app` tool, or kill the app in simulator and run `npx react-native run-ios` again |

**Agent checklist:**

- [ ] Only one Metro process (no duplicate on port)
- [ ] App was started after Metro was ready
- [ ] When needing to reload: refer to 2.3

---

## 3. Build / Install / Retry (React Native & iOS Native)

### 3.1 When Build Fails (e.g. xcodebuild exit code 65)

**Order of operations (simplest first):**

1. Clean build folder, then retry the build command
2. Clear caches and reinstall dependencies: reset Metro cache, `watchman watch-del-all`, remove `node_modules` + lockfile, `npm install`, then `cd ios && rm -rf build Pods Podfile.lock && pod install --repo-update`
3. CocoaPods issues: `pod deintegrate` then `pod install --repo-update`
4. Open `ios/*.xcworkspace` in Xcode for detailed errors in the Report navigator

### 3.2 When to Ask the User

**After 2-3 failed build or run attempts, STOP and ask the user for guidance.** The user may know about required env vars, Xcode version requirements, custom build configurations, monorepo-specific setup, or required external services.

If the project structure is convoluted and the correct build approach is not obvious, **ask the user early** rather than guessing.

### 3.3 Saving Build Workflow for Later

Once you discover the correct build/run workflow for a project, **save it to project memory**. Capture: commands to start Metro, commands to build/run the app, and any required environment setup.

### 3.4 When to Reinstall vs Refresh

| Situation                                             | Action                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| JS/React only changed                                 | Use `debugger-reload-metro` tool. No rebuild.                                         |
| Native code or `pod install` / project config changed | Rebuild: `npx react-native run-ios` (Metro can stay running).                         |
| `node_modules` or `package.json` changed              | `npm install`, then if native deps changed run `cd ios && pod install`. Then rebuild. |
| App needs reinstalling from .app path                 | Use `reinstall-app` tool with bundle ID and .app path.                                |
| Persistent native build errors                        | Full clean + reinstall (step 2 above).                                                |

### 3.5 iOS Simulator Control

| Action                     | Tool / Command                                         |
| -------------------------- | ------------------------------------------------------ |
| List devices               | `list-simulators` tool                                 |
| Boot a simulator           | `boot-simulator` tool (pass UDID)                      |
| Launch an app              | `launch-app` tool (pass bundle ID)                     |
| Restart an app             | `restart-app` tool (terminate + relaunch by bundle ID) |
| Open a URL / deep link     | `open-url` tool                                        |
| Rotate simulator           | `rotate` tool                                          |
| Stop simulator server      | `stop-simulator-server` tool (for a specific UDID)     |
| Stop all simulator servers | `stop-all-simulator-servers` tool                      |

For full simulator setup workflow, refer to the `simulator-setup` skill.

---

## 4. Runtime Problems in the App

### 4.1 Where to Look

| Problem type                      | Tool / Where to look                                                                                        |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **JavaScript errors / logs**      | Use `debugger-log-registry` to get a summary and JSONL file path, then `Grep`/`Read` to search. Use `debugger-console-listen` for real-time logs. |
| **React component hierarchy**     | Use `debugger-component-tree` tool for a text tree, or `debugger-inspect-element` at specific coordinates.  |
| **Visual state of the app**       | Use `screenshot` tool to capture the current screen, or `describe` tool for the accessibility element tree. |
| **Evaluate JS in the app**        | Use `debugger-evaluate` tool to run JavaScript in the app's runtime.                                        |
| **Native crashes / native stack** | `npx react-native log-ios` or iOS Simulator: Debug → Open System Log.                                       |
| **Build/runtime config**          | `metro.config.js`, `babel.config.js`, `package.json` scripts, `ios/Podfile`.                                |

For comprehensive Metro debugging workflows (breakpoints, stepping, pausing), refer to the `metro-debugger` skill.

### 4.2 Do not try to use the DevMenu in React Native apps by default.

Use the argent tools instead.

---

## 5. Testing the App

Check the `environment-inspector` result for test commands. For interactive UI testing with automatic screenshot verification, use the `test-ui-flow` skill.

Ask the user before running tests: confirm which test suite (unit, E2E, or both), whether to use existing CI commands, and whether they want you to run existing tests, write new ones, or explore test cases yourself.
