---
description: Argent iOS Simulator Agent — always-on guidance for methodology and tools for working with, interacting, testing and profiling mobile app work
---

<description>
Argent MCP tools are available in this project for iOS simulator control.
When the user's task involves an iOS app, simulator, or React Native project,
shift to the argent tool-first model described below. The argent tools give you
methods to control the simulator, profile, interact and test mobile applications.
Argent MCP tools are the preferred form of interaction with the application.
</description>

<argent_use_cases>

- User mentions iOS simulator, device, or app interaction
- The app user is working with is a mobile application which can be run in the simulator
- Any tapping, swiping, typing, screenshotting, or inspecting a running app
- Running, debugging, or testing a React Native app
- Profiling performance or diagnosing re-renders in a React Native app
  </argent_use_cases>

<core_rules>

- All simulator interactions go through argent MCP tools — never use `xcrun simctl`,
  raw `curl` to simulator ports, or the simulator-server binary directly.
- Before tapping anything, use a discovery tool to get exact coordinates:
  - `describe` — any iOS app (returns accessibility element tree)
  - `debugger-component-tree` — React Native apps (returns component tree with tap coords)
  - `screenshot` - as a fallback, if above fail or need additional context
- Interaction tools (`tap`, `swipe`, `launch-app`, etc.) return a screenshot automatically.
  Call `screenshot` separately only for a baseline before any action or after a delay.
- If a tap fails twice at the same coordinates, stop retrying. Re-run the discovery tool.
- Always open apps with `launch-app` or `open-url` — never tap home screen icons.
- iOS system popups (permission dialogs, alerts) — dismiss with `keyboard` `key: "enter"`.
- When the session ends or the user says they are done: call `stop-all-simulator-servers`.
  </core_rules>

<react_native_detection>
Project type is determined by the `environment-inspector` subagent (see <subagents>).
When the subagent result is available, use its `is_react_native` field as the authoritative
source — do not re-inspect files manually.

If the subagent has not run yet and project type is unknown, run it first before proceeding.

When `is_react_native` is true: load `react-native-app-workflow` skill, and use
`debugger-component-tree` for all element discovery where needed.
</react_native_detection>

<skill_routing>
Load the matching skill before starting work — skills contain the full step-by-step
procedure, tool reference, and edge-case handling for each workflow.

STARTING A SESSION / SIMULATOR SETUP
Use skill: `simulator-setup`
When:

- Beginning task that involves the simulator
- No simulator is booted yet
- Need to find a UDID or start a simulator-server
- Getting { apiUrl, streamUrl } for the session
  Key tools: list-simulators, boot-simulator, simulator-server

TAPPING, SWIPING, TYPING, GESTURES
Use skill: `simulator-interact`
When:

- Performing any touch interaction (tap, swipe, long-press, pinch, drag)
- Typing text into the app
- Pressing hardware buttons (home, back, volume, power)
- Launching or restarting an app
- Opening a URL or deep link
- Rotating the device
  Key tools: tap, swipe, gesture, paste, keyboard, button, rotate, launch-app,
  restart-app, open-url, describe, debugger-component-tree

TAKING SCREENSHOTS
Use skill: `simulator-screenshot`
When:

- Need a screenshot without performing any interaction first
- Auto-screenshot from an interaction showed a loading/transitional frame, which lacks the needed information
- Checking state after a delay (e.g. waiting for a network response)
  Key tools: screenshot

RUNNING / BUILDING / DEBUGGING A REACT NATIVE APP
Use skill: `react-native-app-workflow`
When:

- You detect that the project you are working with is a react-native application
- Starting Metro or running the iOS app for the first time in this session
- Build fails or pods need reinstalling
- App lost connection to Metro
- Reading JS console logs or native crash logs
- Reloading the JS bundle
- User asks to run, launch, or reinstall the app
- Debugging the react-native application
- Searching for the placement of elements on the screen using react-native app (see debugger-component-tree in the metro-debugger skillń)
  Key tools: debugger-status, debugger-reload-metro, restart-app,
  debugger-console-logs, debugger-console-listen

BREAKPOINTS, STEPPING, JS EVALUATION
Use skill: `metro-debugger`
When:

- Setting or removing breakpoints
- Pausing or stepping through JS execution
- Evaluating JavaScript expressions in the app runtime
- Inspecting the React component tree at a source level
- Diagnosing why a specific code path is not reached
- Searching for the placement of elements on the screen using react-native app (debugger-component-tree tool)
  Key tools: debugger-connect, debugger-set-breakpoint, debugger-remove-breakpoint,
  debugger-pause, debugger-resume, debugger-step, debugger-evaluate,
  debugger-component-tree, debugger-inspect-element, debugger-status

END-TO-END UI TESTING
Use skill: `test-ui-flow`
When:

- Verifying a complete user flow (login, checkout, navigation, form submission)
- Running an interact → screenshot → verify loop
- Testing that a sequence of actions produces the expected visual result
- User asks to "test" a feature by actually using the app
  Key tools: screenshot, describe, debugger-component-tree, tap, swipe,
  paste, keyboard, launch-app

PERFORMANCE PROFILING
Use skill: `react-native-profiler`
When:

- App feels slow or janky
- User asks about re-renders, unnecessary renders, or component performance
- Diagnosing CPU hotspots
- Producing a ranked report of performance issues with source-level fixes
  Key tools: profiler-start, profiler-stop, profiler-analyze,
  profiler-component-source, profiler-cpu-summary,
  profiler-react-renders, profiler-fiber-tree
  </skill_routing>

<subagents>
ENVIRONMENT INSPECTION AT SESSION START
Use subagent: `environment-inspector`
When:
- Environment context of the project is not yet known
- No "Project Environment" section exists in project memory / `MEMORY.md` or you lack information about basic setup workflows
- Need to determine build commands, startup scripts, metro port, platform support, or QA tooling
  If the subagent already ran this session (result in memory), use that context directly — do NOT re-run.
</subagents>

<important_usage_caveats>
LICENSE
Most tools require a Pro license. If any tool returns "No Argent license found":

1. Call `activate-sso` — opens a browser for sign-in and returns { success: true, plan }.
2. If the browser cannot open, it returns `{ ssoUrl }` — show that URL to the user.
3. Alternatively, call `activate-license-key` with the user's license key.

SESSION CLEANUP
When the session ends or the user says they are done:

- Call `stop-all-simulator-servers` to clean up running simulator processes.
- If the user started Metro separately, ask whether they would like you to call
  `stop-metro` (specify the port if it is not 8081).

FINDING TAP TARGETS
Before tapping anything, always use a discovery tool to get exact coordinates.
Never guess positions from a screenshot alone.

- Any iOS app: use `describe` (returns accessibility element tree with normalized frames).
- React Native apps: use `debugger-component-tree` (returns component names with tap coords).
- Fallback: use `screenshot` tool if the above fail
  If a tap fails after 2 attempts, stop retrying. Call the discovery tool again to
  verify the element position and current screen state before trying a new coordinate.

REACT NATIVE APPS
Use the `is_react_native` field from the `environment-inspector` subagent result to
determine whether the project is React Native. When true: load the `react-native-app-workflow`
skill and use `debugger-component-tree` for element discovery. Using `describe` can still be
useful when there is, for example, a modal in place.

IOS SYSTEM POPUPS
Permission dialogs and other OS-level popups are not part of the app view hierarchy.
If they cannot be tapped easily, dismiss them by pressing Enter via the `keyboard`
tool (`key: "enter"`) — this confirms the default button and is more reliable than tapping.

WORKSPACE INFORMATION RETRIEVAL
The `gather-workspace-data` tool provides a structured snapshot used internally by the
`environment-inspector` subagent. Retrieve workspace information according to this priority:

1. **Project memory / `MEMORY.md` already has a "Project Environment" section** →
   Use that context directly. Do NOT re-run the subagent or call the tool.
2. **Subagent delegation is available** →
   Run the `environment-inspector` subagent. Never call `gather-workspace-data` yourself;
   the subagent calls it internally and fills in gaps through further inspection.
3. **Subagent delegation is NOT available** →
   Call `gather-workspace-data` directly as a first step, then fill in any gaps by
   manually inspecting project files (package.json scripts, metro config, CI workflows, etc.).

The main agent is responsible for persisting the subagent's JSON result to project memory.
</important_usage_caveats>
