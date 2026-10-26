---
name: argent-test-ui-flow
description: Autonomously test an app UI (iOS or Android) by running interact-screenshot-verify loops using argent MCP tools. Use when testing UI flows, verifying login works, testing navigation, running UI test scenarios, manual QA steps, visible UI changes, or visual behavior.
---

## Before testing

Resolve the device first: call `list-devices`, prefer a running device on the platform the user named, and don't pick a cabled phone without explicit intent. Setup: `argent-ios-simulator-setup` / `argent-android-emulator-setup`. The interaction tool names are identical on iOS and Android.

Physical iPhone (`kind: "device"`): read `argent-ios-device-interact` first. `launch-app` before anything; `describe` fails while the app is backgrounded.

## 1. Workflow

For implementation tasks that modify visible UI, this workflow also serves as a visual acceptance path.

1. **Baseline screenshot**: call `screenshot` to see the current UI state. For visual regression comparison or UI change verification, capture the baseline at `scale: 1.0` with `includeImageInContext: false` and keep the returned `path` before editing whenever feasible.
2. **Find target**: get element coordinates from a discovery tool before tapping:
   - **React Native apps**: `debugger-component-tree` returns component names with (tap: x,y) coordinates and is the preferred tool for RN apps on either platform. Set it up with the `argent-react-native-app-workflow` skill; on Android also run `adb -s <serial> reverse tcp:8081 tcp:8081` so Metro is reachable from the device.
   - **Standard app screens, in-app modals and system dialogs**: `describe`. Fall back to `screenshot` only if an overlay is not exposed reliably. When the app raises its own permission dialog, answer it here; that's the real flow under test. To take a prompt _out_ of the flow, use `argent-settings-permissions` during setup.
   - **Fallback**: use `screenshot` to estimate where the component is, then verify immediately after the action.
3. **Interact**: perform the action (`gesture-tap`, `gesture-swipe`, `keyboard`, `button`, ...); you receive a screenshot automatically.
4. **Verify**: check the returned screenshot. If it shows a loading/transitional state, block with `await-ui-element` (expected element `visible`, or a spinner `hidden`) rather than a guessed delay (its result carries the new screenshot and element tree), but only with a selector you can trust (`text`/`identifier`/`role`) that the screen is known to have or that you saw in a prior `describe`; a guessed one just times out. Otherwise use a short fixed wait. Pick evidence by what's being asserted:
   - **Visual** (layout, spacing, color, typography, image/icon rendering, clipping, overflow, text rendering): prefer `screenshot-diff` against the step 1 baseline: it surfaces pixel-visible changes the auto-screenshot might miss. Fall back to inspecting the auto-screenshot only when a stable baseline isn't available.
   - **Structural** (navigation state, element existence, accessibility labels/values, selection, hierarchy, route): verify with `describe`, `debugger-component-tree`, or `native-describe-screen`.
   - **Runtime / log / network** (console errors, API calls, persistence, timing): verify with `view-network-logs`, `debugger-log-registry`, `debugger-evaluate`, or targeted tests. A `not_connected` result from the debugger tools is not evidence about the app: follow its `guidance`, then re-verify.
   - **Mixed**: collect evidence for each relevant class.
   - Report the combined verdict: expected behavior, observed behavior, evidence used, and any blocker for requested visual diffing.
5. **Repeat** for each step in the flow.

## 2. Example: login flow

```
1. screenshot → see login screen
2. gesture-tap { x: 0.5, y: 0.4 }  → tap email field
3. keyboard { text: "user@example.com" }
4. gesture-tap { x: 0.5, y: 0.55 } → tap password field
5. keyboard { text: "{{secret:APP_PASSWORD}}" }
6. gesture-tap { x: 0.5, y: 0.7 }  → tap Login button
7. screenshot → verify home screen appeared
```

> **Credentials:** never type plaintext credentials; use a `{{secret:<NAME>}}` placeholder (the `keyboard` description lists where it is read from and what to do when a name is missing). Never invent credentials or echo secret values into reports or saved files.

## 3. Recovery Pattern

- Screen mid-transition or loading: wait with `await-ui-element` as in step 4, then re-check. Fall back to a fixed wait + `screenshot` only when no element reliably marks the transition. Don't poll with repeated screenshots.
- Tap misses the target: re-run discovery (`describe` / `debugger-component-tree`) and retry once with new coordinates. If it fails twice, stop and report that the element was not found.
- Permission dialog or modal visible: re-run `describe` first. Stay in screenshot-driven navigation only while the overlay is not exposed reliably: tap one visible button at a time, verify with the returned screenshot, and switch back to `describe` / `debugger-component-tree` as soon as it is dismissed.
- A **saved e2e test** fails during `e2e-execute` replay (as opposed to the live steps above): follow `argent-create-e2e`'s [Diagnose a replay failure](../argent-create-e2e/references/reliability-and-recovery.md#diagnose-a-replay-failure): classify the failure, inspect the actual screen, repair the smallest justified unit, then replay the full e2e test.

**Record for replay**: if a tested flow is likely to be repeated, use the `argent-create-e2e` skill to record it as a `.yaml` test, so it can be replayed later with a single `e2e-execute` call.

## Related Skills

| Skill                              | When to use                                              |
| ---------------------------------- | -------------------------------------------------------- |
| `argent-device-interact`           | Tool usage for tapping, swiping, typing (iOS + Android)  |
| `argent-screenshot-diff`           | Visual regression and before/after screenshot comparison |
| `argent-ios-simulator-setup`       | Booting and connecting an iOS simulator                  |
| `argent-android-emulator-setup`    | Booting and connecting an Android emulator               |
| `argent-react-native-app-workflow` | Starting the app, Metro, build issues                    |
| `argent-metro-debugger`            | Console logs, JS evaluation, component inspection        |
| `argent-create-e2e`                | Record a test sequence as a replayable e2e test          |
