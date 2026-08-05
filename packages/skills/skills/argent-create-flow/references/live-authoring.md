# Live authoring

Read this file before creating or changing a flow. The saved path must be exercised through the recorder as it is discovered; only the final syntax cleanup happens afterward.

[Recorder tools](#recorder-tools) · [Start in the correct order](#start-in-the-correct-order) · [Record the first walkthrough](#record-the-first-walkthrough) · [Finish and polish](#finish-and-polish) · [Worked example](#worked-example) · [Blocking audit](#blocking-audit) · [Replay](#replay)

## Recorder tools

`flow-add-step`'s `command` parameter takes an MCP tool name. Its `args` value is a JSON **string**, not an object, and is omitted for a no-argument tool:

```text
command: "gesture-tap"
args: "{\"udid\":\"DEVICE\",\"x\":0.5,\"y\":0.35}"
```

Recording a `flow-execute` carries **two** flow names: the top-level `name` is the recording being appended to, `args.name` is the sibling being run (captured as a `run:` step).

### Recording contract

- **Every recording tool takes `name` + `project_root`.** `flow-add-step`, `flow-add-echo`, and `flow-finish-recording` each name the recording they address, repeating the `name` and the absolute `project_root` (an error is returned if the path is not absolute) given to `flow-start-recording`. Nothing is carried over between calls.
- **Recording _state_ is isolated; the device is not.** A recording is keyed by its output file, `<project_root>/.argent/flows/<name>.yaml`, so several can be open at once — different names, different projects — and one recording's steps never land in another's file. Nothing is isolated on the device: every step runs live, so two recordings driving one device interleave real UI actions, and one flow's recorded `restart-app` resets the app under the other. Give each concurrent recording its own device.
- **Starting always truncates the `.yaml`.** `flow-start-recording` resets `<project_root>/.argent/flows/<name>.yaml` to an empty flow on every call — including a name that is only a saved file with no recording in progress, so starting under the name of a committed flow wipes it. `restarted: true` is reported only when a LIVE recording of that flow was discarded, so its **absence does not mean nothing was overwritten**. `discardedSteps` (in the return value) counts the discarded take, but can be absent even on a restart. Starting a _different_ flow abandons nothing.
- **Pick a name unique to your task.** `(project_root, name)` has no ownership check, so another agent starting the same pair silently takes it over and your later appends land in _their_ recording, reporting success. If a call ever reports the recording is no longer active, restart under a fresh name rather than re-adding the step.
- **Start before adding.** Adding to or finishing a flow with no recording in progress returns `No active recording for flow ...`, listing the flows live under the `project_root` you passed. Do not answer it with `flow-start-recording`: you get the same error when your take was finished or dropped by the concurrent-recording cap, and on those branches the `.yaml` is fully populated, so starting truncates a take you wanted. Copy the file aside or record under a fresh name. (A takeover by another agent does not reach this error at all — it resolves to _their_ recording and succeeds, per the previous bullet.)
- **Only successful steps are recorded.** A failed call writes nothing to the flow file; fix the issue and try again. Every recording tool returns the current flow file contents, so you can track what has been recorded as you go.
- **Edit mistakes out after finishing.** Remove or reorder steps in the `.yaml` once `flow-finish-recording` has run; editing it while the recording is still active can be overwritten by the in-memory copy.

## Start in the correct order

### iOS, Android, and Vega e2e flows

1. Call `flow-start-recording` before launching or touching the app.
2. Make the first non-echo recorded action a plain `restart-app` with the device id and app id only. The recorder stores it as `launch:`. Extra restart arguments or a `delayMs` prevent that conversion — an Android `activity` is the case that turns up in practice, and it leaves a raw `tool:` step, so the flow is a fragment rather than e2e.
3. Immediately record `await-ui-element` for the real first screen. Launch waits for platform automation readiness, not for app-specific loading or splash completion.

Never build a selector, landmark, or echo reference from splash-screen content; wait for the real first screen and base the recorded path on that state.

On iOS, Argent must launch the app for the full selector tree to exist, and only `restart-app` guarantees that — `launch-app` foregrounds an already-running, uninstrumented process instead. See [Reliability and recovery: iOS selector recovery](reliability-and-recovery.md#ios-selector-recovery).

### Chromium e2e flows

**Default Chromium window size: `1366 × 768`.** Unless the user or test contract explicitly requires another window size, boot the target with `boot-device`, `electronAppPath`, and `electronArgs: ["--window-size=1366,768"]`. This is the native browser-window size, not page-viewport emulation. Do not record against an already-running target whose window size came from host or session state; launch a fresh target with the explicit size first. If the target cannot honor the requested size, stop and report the blocker instead of recording at a different size.

Call `flow-start-recording` after that boot and before the first in-app action, then record the first-screen wait live. During polish, insert a leading Chromium launch that preserves the same app path and arguments, for example:

```yaml
steps:
  - launch:
      chromium:
        path: ../../app
        args: ["--window-size=1366,768"]
```

The path is relative to the flow file's own directory, `.argent/flows/`, so `../../app` means `<project_root>/app`; an absolute path is also accepted. Preserve any other live boot arguments, and keep exactly one `--window-size` argument. An explicit user or test-contract size replaces the default in both the live boot and saved launch. This packaging exception represents the same app boot used for the live walkthrough; it is not permission to rehearse the UI path.

### Fragments

Stage the documented entry state before recording, then call `flow-start-recording` with a precise `executionPrerequisite`. Describe UI/account/platform state, never a concrete device id. Start recording before the first interaction that belongs to the fragment.

## Record the first walkthrough

For Vega, read [Flow YAML: Composition and platform limits](flow-yaml.md#composition-and-platform-limits) before applying this cycle — it is remote-driven and takes no touch gestures.

**Reach every screen by tapping through the app's own UI.** A recorded `open-url` skips the navigation the flow exists to exercise, so a broken entry point still passes. Starting the app is not navigation.

Repeat this cycle for every action:

1. **Discover without mutating.** Call `describe`, `native-find-views` / `native-describe-screen` (iOS only), `debugger-component-tree` (React Native), or `screenshot` directly. These calls are intentionally not recorded. Never record a `debugger-*` step: `port` is not a device-bind key, so a recorded one replays against whatever Metro owns that port.
2. **Choose a durable target.** Prefer an id, then a text/accessibility label meeting the [stable-selector definition](../SKILL.md#stable-selectors). For iOS ids, use `native-find-views` / `native-describe-screen`; the trimmed accessibility description may omit them.
3. **Narrate before failure can occur.** Add an echo naming the current state, intended action, and expected destination/outcome.
4. **Execute and record immediately.** Call `flow-add-step`; inspect `toolResult`, the `message`, and the returned flow file before moving on.
5. **Verify immediately.** After navigation, record identity then readiness (below). Record requested outcome checks when the state first appears.

### Record identity, then readiness, after every navigation

On the destination screen, in this order:

1. **Identity.** Record `await-ui-element` `visible` on an element that exists **only** on the destination — its root id, or a control no other screen in the flow shows. Anything the source screen also has passes without the navigation happening, so it proves nothing.
2. **Readiness.** Add `- await: { idle: true }` during polish, and name in the preceding echo what it is waiting out. It is a directive, not a tool, so it cannot be recorded live — do not persist `await-screen-idle` instead, which reads only the tree and returns while a transition is still animating over it.

   It never fails; a screen that never settles passes with a ⚠ warning. **If you saw something moving on this screen — a video, a shimmer, a carousel, a spinner — expect that warning**, say so in the echo, and make sure the next action is gated on a stable element rather than on stillness.

   Where a specific control marks the screen usable, record an `await-ui-element` on that control as well — but it does not replace the `idle` gate, which is what waits out motion the tree cannot see.

[What qualifies as destination-only](reliability-and-recovery.md#strong-transition-gates).

### Record absence in three steps, in this order

A `hidden` wait whose selector never matched anywhere in the flow can never fail — it passes just as happily on a typo'd selector or the wrong screen. Record the trio:

1. `await-ui-element` `visible` on the selector, while the element is on screen;
2. the action that removes it;
3. `await-ui-element` `hidden` on the same selector.

Step 1 is what makes step 3 falsifiable, so it must carry the **same** selector — an id or spelling that drifts between the two leaves the absence check proving nothing. A step-1 locator with no identity term of its own (a regex `text` match, a role-only selector) is no evidence either.

### Taps

`flow-add-step` cannot receive a flow selector directly. Locate the element by id/text first, then record `gesture-tap` at the center of its discovered frame. The recorder reads the **pre-tap** tree and stores a strict `tap: { id: ... }` or `tap: { text: ... }` selector. The live coordinates are transport for the gesture, not an acceptable final locator.

When the element cannot be addressed the recorder keeps the raw point, appends the step anyway, and **warns with the reason and the retarget**. Act on that warning before the next action: to replace a kept coordinate, return to the screen the tap started from — with direct MCP calls, never through `flow-add-step` — record the corrected tap, and delete the coordinate step after `flow-finish-recording`. Do not leave both. Keep a point only after the **coordinate fallback gate** in [Reliability and recovery](reliability-and-recovery.md#coordinate-fallback-gate).

**Never record a tap on the on-screen keyboard.** Some platforms expose the whole keyboard as ONE addressable node, so a tap on a key records a selector for the keyboard and replays at its centre — a different key, reported as a pass. The recorder cannot tell that node from a legitimate large control. Type with `keyboard`, which polish folds into `type:`.

### Typing

Record the focus tap, then use `describe` to confirm the field is focused before recording `keyboard`. Use `describe` or an app validation marker to confirm the complete value appeared; for a secure field, do not expose the value in a screenshot or echo. If characters were lost, restore the field with direct MCP tool calls (never through `flow-add-step`). Do not record a duplicate typing step.

Polish folds the focus tap and keyboard step into `type:`, which at replay re-taps the field and waits for it to take focus before injecting keys. That wait is a best effort, not a guarantee — keys go wherever focus actually is, at replay as much as during the walkthrough — which is why the live `describe` check stays and why the value is verified after typing.

Never record a credential literal. Use `{{secret:NAME}}`, resolved at run time from `ARGENT_SECRET_NAME` or a secrets file — see the `keyboard` section of `argent-device-interact` for the full source order.

### Scrolling and swiping

During the live walkthrough, record `gesture-swipe` or Chromium `gesture-scroll` when movement is required. During polish:

- movement whose purpose is to reveal an element becomes selector-targeted `scroll-to`;
- a raw swipe survives only when the gesture itself is under test, such as swipe-to-dismiss, edge-back, or reveal-row-actions.

For every retained raw gesture, add an echo naming the gesture target and record an `await-ui-element` condition that proves its result; polish that condition to `await:` or `assert:`.

### Live waits and checks

Record `await-ui-element` through `flow-add-step`. If its condition is unmet, the response is not an error: `message` contains `step NOT recorded` and `toolResult.success` is `false`. Nothing was appended. Fix the selector or justified timeout and call it again. Never proceed as though the gate passed. Read the `await-ui-element` section of `argent-device-interact` for the complete live condition and selector reference.

**A wait that passes live can still be unconvertible**, because the tool and the runner read different projections of the screen ([per-platform table](flow-yaml.md#the-runner-tree-is-not-the-discovery-tree)). The raw step replays fine either way; it is the `await:`/`assert:` conversion that can fail to resolve. Check each converted wait at polish by replaying the flow, and either re-record it with a selector present in both trees or keep the step raw on purpose.

The live wait tool spells an identifier selector as `identifier`; polished flow YAML uses canonical `id`.

### Wrong turns

Stop immediately. Restore the last valid screen with direct MCP tool calls — invoked normally, never through `flow-add-step`, so nothing is appended to the flow — note the bad recorded step, and continue only from verified state. Do not edit a flow file while its recording is in progress: remote/client recording may keep an authoritative in-memory copy. Remove the bad step after `flow-finish-recording`; if recovery changed or skipped meaningful behavior, re-record that portion live instead of fabricating it.

## Finish and polish

Call `flow-finish-recording`, then read the saved YAML. For recorded steps, apply only semantics-preserving conversions:

| Recorded form                             | Finished form                                                       |
| ----------------------------------------- | ------------------------------------------------------------------- |
| focus `tap` + `tool: keyboard`            | `type: { into: <selector>, text: ..., submit: false }`              |
| keyboard text ending in Enter             | `type:` without `submit: false`; remove Enter from `text`           |
| `tool: await-ui-element` transition/check | `await:` or `assert:`                                               |
| element-seeking swipe/scroll              | `scroll-to:` with target selector, direction, and optional `within` |
| coordinate `tap`/`long-press`             | strict id/text selector after the coordinate fallback gate          |
| `tool: gesture-pinch`                     | `pinch: { on: <selector>, scale: endDistance / startDistance }`     |
| generic `tool: flow-execute` of a sibling | recorder-captured `run:` directive                                  |

Only three unrecorded insertions are allowed during polish, each where you saw the condition live:

- `snapshot:`, which captures state without performing a new app action. Follow [Flow YAML: Snapshots and standalone runs](flow-yaml.md#snapshots-and-standalone-runs) for baseline handling.
- `await: { idle: true }` as the readiness half of a navigation, named by the preceding echo.
- The documented leading Chromium `launch:` that packages the same app path and arguments used by the live `boot-device` call.

Preserve a raw form only when conversion would change behavior:

- Keep `tool: await-ui-element` only when its `pollIntervalMs` or `bundleId` is required. It is unrelated to the fixed `wait:` directive.
- Keep a raw swipe only for a semantic or velocity-sensitive gesture.
- For a pinch, derive `scale` from the recorded distances and target the selector under its center.
- Keep `tool: gesture-pinch` only when it is point-anchored inside a large element or deliberately pans with `endCenterX`/`endCenterY`; the directive would recenter it.
- Keep raw screenshots for useful human-reviewed before/after or diagnostic evidence. For automated visual verification, add `snapshot:` according to [Flow YAML](flow-yaml.md#snapshots-and-standalone-runs).

See [Flow YAML](flow-yaml.md) for exact syntax.

If polish reveals a missing action or acceptance check, the flow is incomplete. Restore its preceding state and execute the missing behavior through the recorder, or re-record; do not append remembered behavior directly to YAML.

## Worked example

This session records a third-party app path; the comments show what the recorder captures before polish:

`FLOW` below abbreviates `name: "open-settings", project_root: "/Users/dev/AcmeNotes"` — every call repeats it verbatim.

```text
flow-start-recording { name: "open-settings", project_root: "/Users/dev/AcmeNotes" }
flow-add-echo { FLOW, message: "Restart Acme Notes; expect the real Home screen" }
flow-add-step { FLOW, command: "restart-app", args: "{\"udid\":\"ABC\",\"bundleId\":\"com.acme.notes\"}" }
# captured as: - launch: com.acme.notes
flow-add-step { FLOW, command: "await-ui-element", args: "{\"udid\":\"ABC\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"home-screen\"}}" }
flow-add-echo { FLOW, message: "On Home; open Settings and expect the Settings screen" }
flow-add-step { FLOW, command: "gesture-tap", args: "{\"udid\":\"ABC\",\"x\":0.91,\"y\":0.94}" }
# pre-tap capture resolves the point to: - tap: { id: settings-tab }
flow-add-step { FLOW, command: "await-ui-element", args: "{\"udid\":\"ABC\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"settings-screen\"}}" }
flow-finish-recording { FLOW }
```

After converting the recorded `await-ui-element` tools to directives, the finished flow is:

```yaml
steps:
  - echo: Restart Acme Notes; expect the real Home screen
  - launch: com.acme.notes
  - await: { visible: { id: home-screen } } # identity: which screen
  - await: { idle: true } # readiness: it stopped moving
  - echo: On Home; open Settings and expect the Settings screen
  - tap: { id: settings-tab }
  - await: { visible: { id: settings-screen } } # identity: which screen
  - await: { idle: true } # readiness: it stopped moving
```

Both screen changes carry the pair. Each `idle` gate is added during polish — it is a directive with no live tool to record.

## Blocking audit

Review the file before replay. Run all four greps and resolve every hit.

```text
# 1. Coordinates and raw gestures
rg -n '(\{ *x:|^ +(x|centerX|fromX|toX):|gesture-(tap|swipe|scroll|drag|pinch|rotate|custom))' .argent/flows/<name>.yaml

# 2. Stored device ids
rg -n '(udid|device_id)' .argent/flows/<name>.yaml

# 3. Unstable gate values: positional ids, and bare (loose) selectors in a condition
rg -n '(-selector-\d+|selector-\d+\b)' .argent/flows/<name>.yaml
rg -n '(await|assert):.*(visible|hidden|exists) *: *["'"'"'A-Za-z0-9]' .argent/flows/<name>.yaml

# 4. Fixed sleeps, and navigation that skipped the UI
rg -n '^\s*- wait:' .argent/flows/<name>.yaml
rg -n 'open-url' .argent/flows/<name>.yaml
```

- Convert every element-targeting point to a selector. Each coordinate `tap:` warned you when it was recorded; this grep is the second chance, not the first, so every remaining hit has to defend itself.
- Convert every raw gesture used only to find an element to `scroll-to`.
- For each remaining point/raw gesture, require the exception evidence and expected-result check from the **coordinate fallback gate** in [Reliability and recovery](reliability-and-recovery.md).
- Require zero stored device ids and zero literal credentials.
- **Reject every positional id in a gate.** Replace with a stable destination-only root or control id.
- **Rewrite every bare-selector condition into an explicit map.** Grep 3's second pattern lists them (it matches `visible: Save`, not `visible: { text: Save }`).
- **Reject data-derived gate values** — a counter, count, username, timestamp, or any number the app computes. Read every `text:` gate and confirm its value is fixed by the app's code; use an anchored `{ matches: '^…$' }` when the full value matters.
- **Every `wait:` must justify itself** — a preceding echo and a following `await:`/`assert:` that proves the state. Prefer replacing it with `await: { idle: true }`.
- **Reject every `open-url` that stands in for a navigation** — restore the source screen and record the tap path live.
- Confirm every added `snapshot:` is intentional, non-mutating, and ready for reviewed baseline creation.
- Confirm the first non-echo e2e step is `launch:` and the next functional step gates the real first screen. If either is missing on mobile/Vega, record it live; only the documented Chromium packaging launch may be inserted during polish.
- **Confirm every navigation has identity and readiness proof** — walk the file top to bottom and, for each action that changes screens, name the two gates that follow it. If either is missing, restore that screen and record it live.
- Confirm every `hidden` gate is preceded by evidence its selector is real: the same selector asserted `visible` earlier in the flow, or a proven containing screen.

## Replay

Run `flow-execute` on the complete polished flow with the absolute project root. For a fragment, verify its prerequisite and rerun with `prerequisiteAcknowledged: true` when requested. A replay you rescued by hand is not a pass: if you tapped, waited, or reset anything to get the run through, the pass does not count.

An `errored` step is not a failed one: it could not be evaluated at all — an unreadable tree, focus unconfirmed with nothing to read it from. Fix the environment named in its reason and rerun; it is not a verdict about the app and never counts for or against a pass.

**A ⚠ on a passing step is a finding, not noise.** From `await: { idle: true }` it means the screen never stopped moving, and the report cannot tell intended motion from a load that never finished. Go and look at that screen, disclose what was moving, and confirm the following step targets a stable element.

The base create-flow gate is one uninterrupted full pass of the finished YAML. Return to the invoking skill for any stronger completion rule: `argent-qa-flows` requires two consecutive full passes of the unchanged flow. For CI, use `argent flow run <name> [--platform ...]`; it exits non-zero on failure.
