---
name: argent-test-ui-flow
description: Autonomously test an app UI (iOS or Android) by running interact-screenshot-verify loops using argent MCP tools. Use when testing UI flows, verifying login works, testing navigation, running end-to-end UI test scenarios, manual QA steps, visible UI changes, or visual behavior.
---

## Platform-agnostic

The interaction tool names are identical on iOS and Android — `find`, `gesture-tap`, `gesture-swipe`, `describe`, `screenshot`, `launch-app`, etc. — and the tool-server auto-dispatches based on the `udid` you pass (UUID-shape → iOS, adb serial → Android).

**Before testing, resolve which device to test on.** Call `list-devices` and follow `<device_selection_rule>`: prefer a running device on any platform;

Once a platform is chosen, the per-platform setup skill takes over:

| Platform | Setup skill                     | Find devices with                                           |
| -------- | ------------------------------- | ----------------------------------------------------------- |
| iOS      | `argent-ios-simulator-setup`    | `list-devices` → `boot-device` with `udid` if none booted   |
| Android  | `argent-android-emulator-setup` | `list-devices` → `boot-device` with `avdName` if none ready |

## 1. Workflow

All interactions go through argent MCP tools. Ensure the simulator/emulator is ready before starting.

For implementation tasks that modify visible UI, this workflow can also serve as a visual acceptance path.

1. **Baseline screenshot**: Call `screenshot` to see the current UI state. For visual regression comparison or UI change verification, capture the baseline at `scale: 1.0` with `includeImageInContext: false` and keep the returned `path` before editing whenever feasible.
2. **Choose one target path**: If you need to learn what is on screen, start with a discovery tool and then use `gesture-tap` on the returned coordinates. Use `find` only for a specific visible control whose text, label, value, role, or id is already known and whose current coordinates you do not already have; confirm `found: true` before assuming the action ran.
   - **React Native apps**: use `debugger-component-tree` — it returns component names with (tap: x,y) coordinates. This is the preferred tool for RN apps on either platform. To use it, resolve the `argent-react-native-app-workflow` skill for setup; on Android you must also run `adb -s <serial> reverse tcp:8081 tcp:8081` so Metro is reachable from the device.
   - **Standard app screens and in-app modals**: use `describe`. On iOS this returns the AX tree (falls back to native-devtools when AX is empty); on Android it returns the uiautomator tree in the same DescribeNode shape.
   - **Permission prompts / system modal overlays**: try `describe` first. Fall back to `screenshot` only if the overlay is not exposed reliably.
   - **Fallback**: use `screenshot` to estimate where the desired component is, then verify immediately after the action.
3. **Interact**: Perform the action (`find`, `gesture-tap`, `gesture-swipe`, `keyboard`, `button`, ...) — you receive a screenshot automatically. If `describe` / `debugger-component-tree` already gave you a tap coordinate for the target, use `gesture-tap` rather than a second `find`.
4. **Verify**: Check the returned screenshot for expected results. If it shows a loading/transitional state, prefer blocking until it settles with `await-ui-element` (expected element `visible`, or a spinner `hidden`) over a guessed delay — but only with a selector you can trust (`text`/`identifier`/`role`) that the screen is known to have, that came from the `find` target, or that you saw in a prior `describe`; a guessed one just times out. Otherwise use a short fixed wait. Pick evidence by what's being asserted:
   - **Visual** (layout, spacing, color, typography, image/icon rendering, clipping, overflow, text rendering): prefer `screenshot-diff` against the baseline captured in step 1 — it surfaces pixel-visible changes the auto-screenshot might miss. Fall back to visual inspection of the auto-screenshot only when a stable baseline isn't available.
   - **Structural** (navigation state, element existence, accessibility labels/values, selection, hierarchy, route): verify with `describe`, `debugger-component-tree`, or `native-describe-screen`.
   - **Runtime / log / network** (console errors, API calls, persistence, timing): verify with `view-network-logs`, `debugger-log-registry`, `debugger-evaluate`, or targeted tests.
   - **Mixed**: collect evidence for each relevant class.
   - Report the combined verdict: expected behavior, observed behavior, evidence used, and any blocker for requested visual diffing.
5. **Repeat** for each step in the flow.

## 2. Template

```
Goal: Test [feature name]

Steps:
1. Classify expected result: visual / structural / runtime-log-network / mixed → choose evidence
2. [Navigate / tap / type; use `describe` -> `gesture-tap` for unknown screens, or `find` directly only for known named/id targets without current coordinates] → verify auto-screenshot and any `found` result
3. screenshot { scale: 1.0, includeImageInContext: false } → save baseline path when visual or mixed evidence needs diffing
4. [Perform the action to test] → verify auto-screenshot
5. Use screenshot-diff when requested or when comparable images add useful visual evidence
6. Report: pass / fail with combined visual, structural, runtime/log/network evidence as applicable
```

## 3. Examples

### Login flow

```
1. screenshot → see login screen
2. find { query: "Email", by: "text", action: "fill", text: "user@example.com" } → confirm found
3. find { query: "Password", by: "text", action: "fill", text: "password123" } → confirm found
4. find { query: "Login", by: "text", action: "tap" } → confirm found
5. screenshot / describe → verify home screen appeared
```

### Scroll and navigation

```
1. screenshot → see list at top
2. gesture-swipe { fromY: 0.7, toY: 0.3 } → scroll down
3. If the item label is known: find { query: "<visible item label>", by: "text", action: "tap" } → confirm found. If not, describe → choose coordinates → gesture-tap.
4. screenshot → verify detail view opened
5. button { button: "back" }
6. screenshot → verify returned to list
```

### Visual behavior check

```
1. Classify expected result as visual or mixed.
2. Navigate to the stable starting state.
3. screenshot { scale: 1.0, includeImageInContext: false } → save baseline path.
4. Use exactly one action path: `find` when the label/id is already known and current coordinates are not; otherwise `describe` / `debugger-component-tree` followed by `gesture-tap`.
5. screenshot-diff { baselinePath, captureCurrent: true, udid, outputDir } → inspect visible change or stability.
6. describe / debugger-component-tree → verify selected state, label, route, or attributes if relevant.
7. Report combined verdict from expected behavior, visual inspection, diff summary, and structural evidence.
```

### Wait for a loading spinner

```
1. gesture-tap { x: 0.5, y: 0.7 } → trigger an action that fetches data
2. screenshot → loading spinner is showing
3. await-ui-element { condition: hidden, selector: { text: "Loading" } } → block until the fetch finishes and the spinner disappears
4. describe / screenshot → verify the fetched content rendered
```

---

## 4. Recovery Pattern

- If a screen is mid-transition or loading: block until it settles with `await-ui-element` (wait for the target element to be `visible`, or the spinner/placeholder to be `hidden`) instead of a blind fixed delay, then re-check. Fall back to a fixed wait + `screenshot` only when no element reliably marks the transition.
- If `find` returns `found: false`, `presenceUnknown: true`, or an ambiguous `matchCount`: narrow the query, set `by`/`index`, or switch to `describe` / `debugger-component-tree` for one full-screen disambiguation pass. After that pass, use returned coordinates with `gesture-tap` when available; use a narrowed `find` only if the inspection did not produce a reliable target coordinate.
- If coordinate tap misses target: re-run discovery tool (`describe` / `debugger-component-tree`), retry once with new coordinates.
- If a permission dialog or modal is visible: re-run `describe` first. Stay in screenshot-driven navigation only when the overlay is not exposed reliably, then switch back to `describe` / `debugger-component-tree` as soon as it is dismissed.
- If tap fails twice at same coordinates: stop, re-discover, report if element not found.
- If a **saved flow** fails during `flow-execute` replay (as opposed to live test steps above): follow `argent-create-flow` skill §10 for structured diagnosis and correction.

## Tips

- **Wait on the UI, don't poll.** When a step needs the screen to change first, gate it with `await-ui-element` (block until an element is `visible`/`hidden` or contains `text`) rather than repeated `screenshot` calls with fixed sleeps. See the `await-ui-element` section of `argent-device-interact`.
- **Use `gesture-custom` for long-press** context menus (800ms hold).
- **Report clearly**: state what you expected, what you saw, and the verdict.
- **Permission modals**: try `describe` first. Use `screenshot` only as fallback, tap one visible button at a time, and verify with the returned screenshot before continuing.
- **Record for replay**: If a tested flow is likely to be repeated, use the `argent-create-flow` skill to record it as a `.yaml` script. This lets you replay the entire sequence later with a single `flow-execute` call instead of re-running each step manually.

## Related Skills

| Skill                              | When to use                                              |
| ---------------------------------- | -------------------------------------------------------- |
| `argent-device-interact`           | Tool usage for tapping, swiping, typing (iOS + Android)  |
| `argent-screenshot-diff`           | Visual regression and before/after screenshot comparison |
| `argent-ios-simulator-setup`       | Booting and connecting an iOS simulator                  |
| `argent-android-emulator-setup`    | Booting and connecting an Android emulator               |
| `argent-react-native-app-workflow` | Starting the app, Metro, build issues                    |
| `argent-metro-debugger`            | Breakpoints, console logs, JS evaluation                 |
| `argent-create-flow`               | Record a test sequence as a replayable flow              |
