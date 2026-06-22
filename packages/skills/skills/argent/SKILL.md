---
name: argent
description: Argent MCP routing and usage for iOS Simulator, Android Emulator, and Chromium (CDP) apps. Use when the user mentions simulator, emulator, device, or app interaction; tapping, swiping, typing, screenshots, or inspecting a running app; visible mobile UI, layout, styling, copy, navigation, or screen changes; manual QA, UI QA, or visual behavior validation; running, debugging, or testing React Native or a Chromium/Electron app; profiling performance or diagnosing re-renders; or any work that uses argent MCP tools or the argent CLI.
---

# Argent

If Argent is installed, its MCP tools are the preferred way to control iOS simulators, Android emulators, and Chromium (CDP) apps. Use the `argent` command only to manage or inspect the toolkit itself (`argent --help`, `argent --version`).

A **Chromium (CDP) app** is any Chromium runtime exposing a Chrome DevTools Protocol endpoint — an Electron app (boot with `boot-device` + `electronAppPath`) or a Chromium-family browser (Chrome/Brave/Edge) launched with `--remote-debugging-port`. All are driven through the same tool surface and tagged `platform: "chromium"`. On Chromium, scroll with `gesture-scroll` and drag with `gesture-drag` — `gesture-swipe` is touch-only.

## Availability

**IMPORTANT:** Run this check once per session, before the first Argent tool call or `argent` command. Do not re-probe before later calls.

1. Are `mcp__argent__*` tools in your tool list? If none are present, Argent is not available.
2. If still unsure, run `command -v argent`. A non-zero exit means the CLI is not on PATH.

If Argent **is** available, proceed normally.

If Argent is **absent**, treat it as an expected state — not an error to retry. **IMPORTANT:** Do not call `mcp__argent__*` tools, do not run `argent` commands, and do not attempt any Argent workflow. Tell the user once, and ask if you should continue without Argent:

> Argent isn't installed in this environment. To enable the mobile/Chromium tooling this repo is configured for, run `npx @swmansion/argent init -y` (or `npm i -g @swmansion/argent && argent init -y`).

## Skill Loading

**IMPORTANT:** Always read the relevant Argent sub-skill before executing Argent MCP tools — sub-skills contain the full step-by-step procedure and edge-case handling for each workflow.

Before any touch interaction, read `argent-device-interact`.

## MCP-First, With Fallback

- All simulator/emulator/Chromium interactions go through Argent MCP tools — never use `xcrun simctl`, raw `curl` to simulator ports, or the simulator-server binary directly.
- Interaction tools (`gesture-tap`, `gesture-swipe`, `gesture-pinch`, `gesture-rotate`, `gesture-custom`, `launch-app`, etc.) return a screenshot automatically. Call `screenshot` separately only for a baseline before any action or after a delay.
- If MCP tools are not sufficient and an action can be done with `xcrun`, `adb`, or other commands, use the command — for example changing device options or performing lock, shake, and similar device actions.

## Mandatory Rules

**IMPORTANT:** Never derive tap coordinates from screenshots. Before every tap, call a discovery tool and use coordinates from its result.

- Before booting, running, or interacting with any app, call `list-devices`; prefer running devices unless the user named a platform or device.
- Prefer discovery tools in this order: `describe`, `native-describe-screen` on iOS, then `debugger-component-tree` for React Native.
- `native-user-interactable-view-at-point` / `native-view-at-point` are follow-up diagnostics once you already have a candidate point (iOS only).
- Re-run discovery whenever the screen changes. Screenshots alone are never sufficient for tap coordinates.
- Stop retrying if a tap fails twice at the same coordinates; re-run discovery.
- Read the exact error if `describe` fails, then follow recovery guidance in `argent-device-interact`.
- Before calling gesture tools for the first time, use ToolSearch to load the tool schema.
- Use `launch-app` or `open-url` to open apps; never tap home screen icons.
- Use `run-sequence` for multiple sequential device actions when you do not need to observe the screen between steps.
- Do not use repeated `screenshot` calls as a wait mechanism.
- End device sessions with `stop-all-simulator-servers`. If the user started Metro separately, ask before calling `stop-metro` (specify the port if not 8081).

## Device Selection

Choose devices in this order:

1. Explicit user intent: choose the named platform or device. Look for words like "simulator" and "emulator".
2. Running devices: iOS simulators with state `Booted`, Android devices with `state: "device"`, Chromium (CDP) apps with `platform: "chromium"` and `state: "Running"`.
3. Single-platform project: use the supported platform from `argent-environment-inspector` (`is_native_ios` / `is_native_android`, or React Native with only one platform configured).

If the platform is unspecified, call `list-devices` and pick the booted target. Do not default to iOS.

## React Native Detection

Use the `argent-environment-inspector` subagent as the authoritative source for project type and platform support — do not re-inspect files manually. If it has not run and project type is unknown, run it before proceeding. Use subagents to run `gather-workspace-data` when possible; do not call it yourself if the subagent is available.

When `is_react_native` is true, load `argent-react-native-app-workflow`. Use `debugger-component-tree` for element discovery when useful; fall back to `describe` if responses are too large or unhelpful.

## Skill Routing

**IMPORTANT:** Load the matching Argent skill before executing Argent MCP tools.

- `argent-ios-simulator-setup`: iOS simulator setup, no simulator booted, UDID needed, or simulator-server setup.
- `argent-android-emulator-setup`: Android emulator setup, no emulator running, adb serial needed, or APK install.
- `argent-device-interact`: tapping, swiping, typing, gestures, hardware buttons, app launch/restart, URLs, screenshots, scrolling, device rotation, or visible UI validation.
- `argent-screenshot-diff`: screenshot diff, visual regression, before/after comparison, or stable pixel comparison.
- `argent-react-native-app-workflow`: React Native app running, Metro, builds, pod issues, logs, bundle reload, or reinstall.
- `argent-metro-debugger`: JS evaluation, Metro connection work, React component tree inspection, or `debugger-component-tree`.
- `argent-react-native-profiler`: component profiling, re-render investigation, CPU hotspots, or ranked performance reports.
- `argent-native-profiler`: native profiling — CPU hotspots, UI hangs, memory leak investigation (iOS and Android).
- `argent-react-native-optimization`: startup, bundle size, slow UI, lists, images, navigation, re-renders, or performance optimization. Entry point for all performance work; delegates to `argent-react-native-profiler` for measurement.
- `argent-test-ui-flow`: end-to-end UI testing, manual QA loops, user flow verification, or validating visible UI behavior.
- `argent-create-flow`: record or replay repeated interaction flows, A/B comparisons, regression checks, or repeated profiling paths. Prompt keywords: flow, repeat, test X times.
- `argent-lens`: design alternatives, A/B choices, or variant selection for a screen or component (requires `argent enable argent-lens`). Prompt keywords: variant, design option, alternative, A/B, "let me pick", "show me options".

## Environment Inspection

Use subagent `argent-environment-inspector` when environment context is unknown, project memory lacks setup information, or you need build commands, startup scripts, Metro port, platform support, or QA tooling.

If the subagent already ran this session, reuse its result. The main agent is responsible for persisting its JSON result to project memory when appropriate.
