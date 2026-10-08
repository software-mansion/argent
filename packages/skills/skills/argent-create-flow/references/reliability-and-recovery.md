# Reliability and recovery

Read this file for selector warnings, raw coordinates, unavailable trees, swallowed actions, overlays, or replay failures.

- [Coordinate fallback gate](#coordinate-fallback-gate)
- [iOS selector recovery](#ios-selector-recovery)
- [Other tree sources](#tree-source-recovery-on-android-chromium-and-vega)
- [Strong transition gates](#strong-transition-gates)
- [Obscured targets](#obscured-targets-and-persistent-overlays)
- [Replay diagnosis](#diagnose-a-replay-failure)
- [Corrections](#correct-the-smallest-justified-unit)

## Coordinate fallback gate

Use this target order:

1. A strict stable id.
2. Narrow, stable text or accessibility label.
3. A stable role only when it is unique.
4. `scroll-to` plus one of those selectors for an off-screen target.
5. Raw coordinates only after the checks below.

Convert element-seeking swipes to `scroll-to`. Keep a coordinate swipe only when the gesture itself is the tested action and no directive expresses it.

### Run the gate when capture warns

Work this gate as soon as capture warns that it kept a raw point — and equally when it silently recorded a role-only selector, which warns about nothing. Keep the source screen available and do these checks:

1. **iOS:** read `describe` again after the screen settles. A raw point means the element has no id and no text, or no scope made it unique; the recorder's `message` says which.
2. **Other platforms:** use `debugger-component-tree` for React Native; otherwise, use `describe`. Verify Android and Chromium candidates in step 3. Their discovery trees can omit runner elements.
3. Test each candidate in a scratch fragment with `assert: { visible: <candidate> }` on the valid screen. Inspect every failure before trying a better id, label, app, or container.
4. If source is available, inspect its `testID`, `accessibilityIdentifier`, or `resource-id`. If none exists, report the missing stable id as the real fix.

An unavailable tree makes the candidate test void. It proves the tree was absent, not that the selector failed, so it never authorizes coordinates. Relevant failures include an unavailable accessibility daemon (`ax-service`) on iOS, an unreachable Android helper, an unreachable Chromium CDP session, or missing Vega page source. The recorder quotes the same reason back in its `selector capture failed` warning, so read that warning before treating it as a verdict about the element. Restore the tree and repeat the test.

Keep coordinates only for a genuinely unlabeled target or after all plausible labeled candidates fail against a working flow tree. Add an echo naming the target and a hard check on the action's outcome. Report the point, discovery results, and candidate failures. Re-record every uncleared point.

QA flows are stricter. They can keep a coordinate only for a genuinely unlabeled target. Failed selector candidates alone are insufficient.

## iOS selector recovery

When a launch step, a step error or a recorder `message` says the accessibility daemon is not available, do what the message says. The steps below are the same ladder. Then record the step again.

1. Read the exact error. `describe`, the recorder and the runner quote the daemon's reason. An empty tree alone is not an outage: the screen can be blank or mid-transition. Call `await-screen-idle`, then read `describe` again, as the `argent-device-interact` skill says under "If `describe` fails".
2. If the reason says the simulator was not booted through Argent, call `boot-device` with this simulator's udid and `force: true`, then `restart-app`.
3. If `describe` keeps answering an error that names `ax-service`, call `stop-all-simulator-servers` once, **scoped to `devices: [<this simulator's UDID>]`**. One tool-server serves every agent on this Argent install, so an unscoped call tears down their devices too. This does not change app or account data. Then `restart-app` and read `describe` again.
4. If tap capture kept a raw point, read the `message`. It names the cause: no element under the point, an element without id and text, or an element that no scope makes unique. Only the last one is a verdict about the screen.
5. If it still fails, report the blocker. Do not replace selectors with coordinates in a QA flow.

Use the same explicit UDID throughout. Multiple booted simulators are not a fault. Pass `--device <udid>` when standalone selection is ambiguous.

System apps (`com.apple.*`) have a flow tree like any other app. A `launch:` of a system app starts it and reads its tree; no coordinate-only form is needed.

## Tree source recovery on Android, Chromium, and Vega

While the required source is down, selector failures and raw-point capture are void. Restore the source and re-record affected taps.

| Platform | Symptom                                | Recovery                                                                         |
| -------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| Android  | Cannot reach the argent android helper | Argent reinstalls it once; if it persists, read the device's reason in the error |
| Chromium | No reachable CDP session               | Boot again with `electronAppPath` and remote debugging                           |
| Vega     | Toolkit returns no page source         | Relaunch an app built with automation support                                    |

On Android, healthy `describe` output does not prove the flow tree is available. It can fall back to legacy `uiautomator`, while the runner refuses that trimmed fallback.

## Strong transition gates

Every navigation needs destination identity followed by readiness. Do not identify a screen with a shared header, persistent tab bar, source element, positional id, counter, username, timestamp, or other data-derived value.

Prefer navigation with a fixed destination. A back button or swipe pops one stack entry, so repeated visits can change its destination. Use back only when back navigation is under test, and gate its result like any other screen change.

## Obscured targets and persistent overlays

A selector tap can resolve the intended element while an overlay receives the touch.

When an overlay intersects the next target:

1. Record the overlay as `visible` while it exists.
2. Record its real dismissal action.
3. Record the same selector as `hidden`.
4. Only then touch the covered region.

Do not rely on auto-dismiss timers. Prefer an app e2e affordance that disables transient overlays. On iOS, use `native-user-interactable-view-at-point` for hit-test diagnosis. Other platforms rely on the recorded visibility trio.

Keep a dismissal swipe only when the UI supports it. Pass it through the coordinate gate and hard-check that the overlay disappeared.

## Diagnose a replay failure

Classify before editing:

| Outcome            | Meaning                                        | Response                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hard failure       | A step fails and later steps skip              | Inspect that step and actual state                                                                                                                                                                       |
| Environment error  | The reason says the check could not run        | Repair the environment and rerun; it is no verdict about the app. A failed `launch:` is `errored` too but **is** a verdict — treat it as a hard failure                                                  |
| Silent misfire     | The run passes but final state is wrong        | Restore the first wrong screen and record a stronger gate                                                                                                                                                |
| Partial divergence | An intermediate result disagrees with its echo | Find the first divergent transition                                                                                                                                                                      |
| Acceptance failure | Actions pass but a requested check fails       | Preserve the check and investigate behavior                                                                                                                                                              |
| Idle warning       | A readiness step passes without settling       | Read [which of the six warnings](flow-yaml.md#idle-readiness) it is, then gate the next action on a stable element                                                                                       |
| Unsettled gesture  | A selector-less gesture passes unsettled       | Restore the tree source ([iOS](#ios-selector-recovery), [other platforms](#tree-source-recovery-on-android-chromium-and-vega)); the green says [only that the gesture was sent](flow-yaml.md#directives) |

Then:

1. Record the first failure or divergence index and message.
2. Capture `screenshot` and `describe`. Use native or React Native discovery when needed.
3. Compare actual state with the preceding echo and expected destination.
4. Classify the cause: selector, screen, missing element, readiness, stale data, optional interstitial, or product behavior.
5. State the diagnosis in one sentence before correcting it.

## Correct the smallest justified unit

- For one parameter or selector error, edit the YAML and prefer a stable selector.
- For readiness or identity failure, repair that gate and audit every transition with the same shape.
- For one missing transition or two to three structural steps, copy the working prefix and re-record the affected span live.
- For four or more broken steps, unclear state, or a comparison or profiling flow, fully re-record.
- Treat manual recovery as diagnosis only. It never counts as a replay pass.

Starting again under the same name truncates the YAML. Copy any working prefix before re-recording.

### Make every replacement gate stronger

| Weak gate                     | Do not use     | Add the missing proof                     |
| ----------------------------- | -------------- | ----------------------------------------- |
| Shared or positional identity | Longer timeout | Destination-only root or control          |
| Tap lost during motion        | Fixed wait     | `idle` after destination identity         |
| Toast absorbs tap             | Retry          | Verified overlay dismissal                |
| `hidden` never established    | Longer timeout | Same-selector `visible`, action, `hidden` |
| Typed value is wrong          | Retype         | Assert the committed value                |

State the added proof before rerunning.

### Correction limit

After each correction, audit and replay from the declared start. Stop after two unsuccessful correction cycles and report the remaining blocker. If failures move while the flow grows, re-record the affected span instead of adding more patches.

Never weaken, remove, or hide a requested check to obtain a pass. Keep a failing product check and report the flow as an unproven regression artifact. QA remains incomplete until its two-pass gate succeeds.
