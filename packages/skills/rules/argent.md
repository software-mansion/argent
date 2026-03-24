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

<tapping_rule>
**HARD RULE: NEVER derive tap coordinates from a screenshot.**
BEFORE EVERY TAP, you MUST call `describe` or `debugger-component-tree` and extract coordinates from the result. This is not optional. Whenever something changed YOU MUST first call `describe` or `component-tree` to not try and hallucinate the positions of the elements. Do not tap if you have not called a discovery tool in the current step. Screenshots alone are never sufficient for coordinates.

`describe` is good for system-level components
`component-tree` is good for react-native specific components

If `describe` is not sufficient ALWAYS do a followup of `component-tree` in react-native apps. Do your best to NOT GUESS THE COORDINATES.
</tapping_rule>

<core_rules>

- All simulator interactions go through argent MCP tools — never use `xcrun simctl`,
  raw `curl` to simulator ports, or the simulator-server binary directly.
- Before calling any gesture tool for the first time, use ToolSearch to load its schema.
- IMPORTANT: NEVER tap anything without knowing exact coordinates. DO NOT GUESS WHERE TO TAP. Especially when navigated to another screen after an action you MUST **always** use a discovery tool `describe` or `debugger-component-tree` to get exact coordinates. Reference:
  - `describe` — any iOS app (returns accessibility element tree). Preferred.
  - `debugger-component-tree` — React Native apps (returns component tree with tap coords)
- Interaction tools (`gesture-tap`, `gesture-swipe`, `gesture-pinch`, `gesture-rotate`, `gesture-custom`, `launch-app`, etc.) return a screenshot automatically.
  Call `screenshot` separately only for a baseline before any action or after a delay.
- If a **tap fails twice** at the same coordinates, **stop retrying**. Re-run the discovery tool.
  For example, if you've used `describe`and it was insufficient - then try `component-tree` if in react-native app. Based on which was more succesful - use the preffered option in the future.
- Always open apps with `launch-app` or `open-url` — never tap home screen icons.
- iOS system popups (permission dialogs, alerts) — dismiss with `keyboard` `key: "enter"`.
- When the session ends or the user says they are done: call `stop-all-simulator-servers`.
  If the user started Metro separately, ask whether to call `stop-metro` (specify the port if not 8081).
- If any of the tooling fails because of permissions / accessibility error, **inform the user immediately** and provide instructions on possible solutions. Do not assume that the tool is unusable. Examples, where such may occur: `describe`.
- Before executing argent-mcp tool **always** read relevant skills for guidance, as in skill_routing section.
- If tools provided by mcp-server are not sufficient and action can be done using `xcrun` or other commands, use the command. Examples: changing simulator options, performing simulator action such as lock, shake, etc.
  </core_rules>

<react_native_detection>
Project type is determined by the `environment-inspector` subagent (see <subagents>).
When the subagent result is available, use its `is_react_native` field as the authoritative
source — do not re-inspect files manually.

If the subagent has not run yet and project type is unknown, run it first before proceeding.

When `is_react_native` is true: load `react-native-app-workflow` skill. Use `debugger-component-tree` for element discovery - if the responses are large or unhelpful, try `describe`.
</react_native_detection>

<skill_routing>
Load the matching skill before starting work and executing tools from argent-mcp — skills contain the full step-by-step
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

PERFORMANCE OPTIMIZATION
Use skill: `react-native-optimization`
When: App feels slow, user asks to optimize, reducing bundle size, improving startup time, fixing re-renders, optimizing lists/images/navigation, or any performance-related task. This is the entry-point skill for all performance work — it delegates to `react-native-profiler` for measurement.

APP & COMPONENT PROFILING
Use skill: `react-native-profiler`
When: To measure performance of specific components, to find app-wide bottlenecks. Investigating re-renders or CPU hotspots, producing ranked performance reports.

NATIVE iOS PROFILING
Use skill: `ios-profiler`
When: Profiling native iOS performance (CPU hotspots, UI hangs, memory leaks via Instruments). Useful as a reference for iOS-specific investigation when running dual profiling via `react-native-profiler`.

RECORDING & REPLAYING FLOWS
Use skill: `create-flow`
When: A multi-step interaction sequence needs to be repeated — re-profiling after a fix, A/B comparisons, regression checks, user says "again" / "run that flow", or you worked through a complex path worth saving. Also use proactively: if you are about to repeat steps you already performed, record first, then replay.
Prompt keywords: flow, repeat, test X times
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
