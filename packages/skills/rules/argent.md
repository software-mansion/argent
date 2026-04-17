---
description: Argent Mobile App Agent — always-on guidance for methodology and tools for working with, interacting, testing and profiling iOS simulator and Android emulator apps
alwaysApply: true
---

<description>
Argent MCP tools are available in this project for iOS simulator and Android emulator control. Argent MCP tools are the preferred form of interaction with the application.
Running MCP server and managing the Argent toolkit utilises `argent` command - if asked use `argent --help` for reference.
To check current version of MCP server run `argent --version` command.

Use cases:

- User mentions iOS simulator, Android emulator, device, or app interaction
- The app user is working with is a mobile application which can be run in a simulator/emulator
- Any tapping, swiping, typing, screenshotting, or inspecting a running app
- Running, debugging, or testing a React Native app (iOS or Android)
- Profiling performance or diagnosing re-renders in a React Native app (iOS profiler tooling is iOS-only; React profiler works on either platform)
  </description>

<platform_dispatch>
<important>Interaction tools are unified across iOS and Android. Pass the device id as `udid` and the tool-server dispatches based on its shape.</important>

- **iOS udid**: UUID shape — `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX` (from `list-simulators`). Or iOS 17+ short form `XXXXXXXX-XXXXXXXXXXXXXXXX`.
- **Android udid**: adb serial (from `android-list-emulators`) — `emulator-5554`, `R5CT12345678`, `192.168.1.7:5555`, etc.

Unified tools (pass `udid`): `gesture-tap`, `gesture-swipe`, `gesture-custom`, `gesture-pinch`, `gesture-rotate`, `button`, `keyboard`, `rotate`, `screenshot`, `describe`, `launch-app`, `restart-app`, `reinstall-app`, `open-url`, `run-sequence`.

Navigation + gestures (including multi-touch pinch/rotate/custom) route through `simulator-server`, which the binary dispatches to iOS or Android internally. `describe` uses AXRuntime → native-devtools fallback on iOS and `uiautomator dump` on Android; app-lifecycle tools (`launch-app` / `restart-app` / `reinstall-app` / `open-url`) use `xcrun simctl` on iOS and `adb` / `am` / `monkey` on Android.

Platform-specific tools (no unified counterpart):

- **iOS**: `list-simulators`, `boot-simulator`, `stop-simulator-server`, `stop-all-simulator-servers`, native-devtools suite, iOS Instruments profiler, `paste`.
- **Android**: `android-list-emulators`, `android-boot-emulator`, `android-stop-app`, `android-logcat`.

If the project only has an `android/` directory (no `ios/`), start from `android-list-emulators`; if only iOS, start from `list-simulators`. For hybrid projects, ask the user which platform to target. Never pass an iOS UDID to an Android-only tool or vice versa.
</platform_dispatch>

<tapping_rule>
<important>**Never** derive tap coordinates from a screenshot</important>
Before **every** tap, you MUST call a discovery tool and extract coordinates from the result. This is not optional. Preferred tools are, in order:

**iOS:**

- `describe` - native app-level components and safely targetable foreground apps
- `native-describe-screen` - accessibility screen description via injected native devtools
- `debugger-component-tree` - react-native specific components

`native-user-interactable-view-at-point` / `native-view-at-point` are follow-up diagnostics once you already have a candidate point.

**Android:**

- `android-describe-screen` - uiautomator-based UI tree (same shape as iOS `describe`)
- `debugger-component-tree` - react-native specific components (requires `adb reverse tcp:8081 tcp:8081` so Metro is reachable)

Whenever something changed YOU MUST first call the platform's describe tool, or another appropriate discovery tool so you do not hallucinate element positions. Do not guess coordinates if you can use a discovery tool. Do not tap if you have not called a discovery tool in the current step. Screenshots alone are never sufficient for coordinates.

If a **tap fails twice** at the same coordinates, **stop retrying**. Re-run the discovery tool.

If the describe tool fails, **read the exact error before reacting**, follow the recovery guidance in `argent-simulator-interact` (iOS) or `argent-android-emulator-interact` (Android).

Before starting to interact with the app, read `argent-simulator-interact` (iOS) or `argent-android-emulator-interact` (Android).
</tapping_rule>

<skill_reading_rule>
<important>Always read relevant skills for guidance before executing argent-mcp tool - read skill_routing reference</important>
</skill_reading_rule>

<general_rules>

- All simulator/emulator interactions go through argent MCP tools — never use `xcrun simctl`, raw `adb` for tap/swipe/screenshot, `curl` to simulator ports, or the simulator-server binary directly.
- Before calling any gesture tool for the first time, use ToolSearch to load its schema.
- Interaction tools (`gesture-tap`, `gesture-swipe`, `button`, `keyboard`, `rotate`, `launch-app`, `restart-app`, `open-url`, `describe`, `run-sequence`) return a screenshot automatically. Call `screenshot` separately only for a baseline before any action or after a delay.
- Always open apps with `launch-app` / `open-url` — never tap home-screen / launcher icons.
- Use `run-sequence` when performing multiple sequential actions where you don't need to observe the screen between steps. Works on both iOS and Android; iOS-only step types (gesture-pinch / gesture-rotate / gesture-custom) throw if the run-sequence udid is Android.
- When the session ends or the user says they are done:
  - iOS — call `stop-all-simulator-servers`.
  - Android — shut down the emulator from its own UI or via `adb -s <serial> emu kill` if the user wants it off. Argent does not keep persistent per-emulator state, so no server-side teardown is required.
  - If the user started Metro separately, ask whether to call `stop-metro` (specify the port if not 8081).
- If tools provided by mcp-server are not sufficient and an action can be done using `xcrun` / raw `adb` / other commands, use the command. Examples: simulator lock/shake, `adb emu rotate`, `adb reverse tcp:8081 tcp:8081` for Android Metro reachability.
- When waiting for an action, do not call `screenshot` repeatedly without a proper wait mechanism. Six consecutive screenshot calls with no adequate delay between them will cause context bloat.
  </general_rules>

<react_native_detection>
Project type is determined by the `argent-environment-inspector` subagent (see `subagents` section).
When the subagent result is available, use its `is_react_native` field as the authoritative
source — do not re-inspect files manually.

If the subagent has not run yet and project type is unknown, run it first before proceeding. Always use subagents if available to run `gather-workspace-data` data tool, if possible do not run yourself.

When `is_react_native` is true: load `argent-react-native-app-workflow` skill. Use `debugger-component-tree` for element discovery — if the responses are large or unhelpful, fall back to `describe` (iOS) or `android-describe-screen` (Android).
</react_native_detection>

<skill_routing>
Load the matching skill before starting work and executing tools from argent-mcp — skills contain the full step-by-step
procedure and edge-case handling for each workflow.

iOS SIMULATOR SETUP
Skill: `argent-simulator-setup`
When: Beginning a task that involves the iOS simulator, no simulator booted yet, need UDID or simulator-server.

ANDROID EMULATOR SETUP
Skill: `argent-android-emulator-setup`
When: Beginning a task that involves the Android emulator, no emulator running yet, need a serial, or about to install an APK.

iOS TAPPING, SWIPING, TYPING, GESTURES, SCREENSHOTS, SCROLLING
Skill: `argent-simulator-interact`
When: Performing touch interactions on iOS, typing, pressing hardware buttons, launching/restarting apps, opening URLs, rotating device, or taking standalone screenshots.

ANDROID TAPPING, SWIPING, TYPING, GESTURES, SCREENSHOTS, SCROLLING
Skill: `argent-android-emulator-interact`
When: Performing touch interactions on Android, typing, pressing hardware buttons, launching/restarting apps, opening URLs, rotating device, reading logcat, or taking standalone screenshots.

RUNNING / BUILDING / DEBUGGING REACT NATIVE APP
Skill: `argent-react-native-app-workflow`
When: Project is react-native, starting Metro or running the iOS / Android app, build failures, pod issues, lost Metro connection, reading logs, reloading JS bundle, reinstalling app. Includes `./gradlew` and `adb reverse` guidance for the Android path.

JS EVALUATION, METRO CONNECTION, REACT NATIVE
Skill: `argent-metro-debugger`
When: evaluating expressions, inspecting React component tree at source level, finding element placement via `debugger-component-tree`.

REACT APP & COMPONENT PROFILING
Use skill: `argent-react-native-profiler`
When: To measure performance of specific components, to find app-wide bottlenecks. Investigating re-renders or CPU hotspots, producing ranked performance reports.

NATIVE iOS PROFILING
Use skill: `argent-ios-profiler`
When: Profiling native iOS performance (CPU hotspots, UI hangs, memory leaks via Instruments). Useful as a reference for iOS-specific investigation when running dual profiling via `argent-react-native-profiler`.

PERFORMANCE OPTIMIZATION
Use skill: `argent-react-native-optimization`
When: App feels slow, user asks to optimize, reducing bundle size, improving startup time, fixing re-renders, optimizing lists/images/navigation, or any performance-related task. This is the entry-point skill for all performance work — it delegates to `argent-react-native-profiler` for measurement.

END-TO-END UI TESTING
Skill: `argent-test-ui-flow`
When: Verifying complete user flows, running interact → screenshot → verify loops, testing features by using the app.

RECORDING & REPLAYING FLOWS
Use skill: `argent-create-flow`
When: A multi-step interaction sequence needs to be repeated — re-profiling after a fix, A/B comparisons, regression checks, user says "again" / "run that flow", or you worked through a complex path worth saving. Also use proactively: if you are about to repeat steps you already performed, record first, then replay.
Prompt keywords: flow, repeat, test X times
</skill_routing>

<subagents>
ENVIRONMENT INSPECTION AT SESSION START
Use subagent: `argent-environment-inspector`
When:
- Environment context of the project is not yet known
- No "Project Environment" section exists in project memory / `MEMORY.md` or you lack information about basic setup workflows
- Need to determine build commands, startup scripts, metro port, platform support, or QA tooling
  If the subagent already ran this session (result in memory), use that context directly — do NOT re-run.
Rules:
  - Run the `argent-environment-inspector` subagent if possible. Never call `gather-workspace-data` yourself - do only if subagent is not available.
  - The main agent is responsible for persisting the subagent's JSON result to project memory
</subagents>
