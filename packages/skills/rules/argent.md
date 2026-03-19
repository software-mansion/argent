---
description: Argent iOS Simulator Agent — always-on guidance for methodology and tools for working with, interacting, testing and profiling mobile app work
alwaysApply: true
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
  If the user started Metro separately, ask whether to call `stop-metro` (specify the port if not 8081).
  </core_rules>

<react_native_detection>
Project type is determined by the `environment-inspector` subagent (see <subagents>).
When the subagent result is available, use its `is_react_native` field as the authoritative
source — do not re-inspect files manually.

If the subagent has not run yet and project type is unknown, run it first before proceeding.

When `is_react_native` is true: load `react-native-app-workflow` skill, and use
`debugger-component-tree` for all element discovery where needed. `describe` can still
be useful when there is a modal or system-level overlay in place.
</react_native_detection>

<skill_routing>
Load the matching skill before starting work — skills contain the full step-by-step
procedure, tool reference, and edge-case handling for each workflow.

SIMULATOR SETUP
Use skill: `simulator-setup`
When: Beginning a task that involves the simulator, no simulator booted yet, need UDID or simulator-server.

TAPPING, SWIPING, TYPING, GESTURES, SCREENSHOTS
Use skill: `simulator-interact`
When: Performing touch interactions, typing, pressing hardware buttons, launching/restarting apps, opening URLs, rotating device, or taking standalone screenshots.

RUNNING / BUILDING / DEBUGGING A REACT NATIVE APP
Use skill: `react-native-app-workflow`
When: Project is react-native, starting Metro or running iOS app, build failures, pod issues, lost Metro connection, reading logs, reloading JS bundle, reinstalling app.

BREAKPOINTS, STEPPING, JS EVALUATION
Use skill: `metro-debugger`
When: Setting/removing breakpoints, pausing/stepping through JS, evaluating expressions, inspecting React component tree at source level, finding element placement via `debugger-component-tree`.

END-TO-END UI TESTING
Use skill: `test-ui-flow`
When: Verifying complete user flows, running interact → screenshot → verify loops, testing features by using the app.

PERFORMANCE PROFILING
Use skill: `react-native-profiler`
When: App feels slow, investigating re-renders or CPU hotspots, producing ranked performance reports.

PERFORMANCE OPTIMIZATION
Use skill: `react-native-optimization`
When: Applying performance fixes, reducing bundle size, improving startup time, optimizing lists/images/navigation, fixing re-render issues, or after profiling to apply suggested improvements.
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
