# Record

Read this file before you record a flow or record steps again. Do each action through the recorder. Edit the YAML only after `flow-finish-recording`.

## Recorder contract

- Give the same `name` and the same absolute `project_root` to each recording tool. Use a name that is unique to your task. Give each concurrent recording its own device.
- `flow-start-recording` erases the named YAML, also a complete flow. Make a copy of the previous flow first. If a call says that the recording is inactive, record with a new name.
- After each `flow-add-step` call, read `recorded`, `message`, and `toolResult`. The recorder also records a call that returns an unmet condition.
- `flow-add-step.command` is a tool name, and `args` is a JSON string. Most directive names get guidance and record nothing. `rotate` is also a tool name: the call turns the device and records a `tool: rotate` step. `tool` returns an error.
- If `savedTo` is `null`, the write of the YAML file failed on your side. The step is in the recording. Do not restart the recording. Continue, and read the file after `flow-finish-recording`.

## Start

1. Call `flow-start-recording` before you launch or touch the app.
2. For an e2e flow, record `restart-app` with only the device id and the app id. The recorder writes it as `launch:`. Other arguments keep a raw tool step, and the flow becomes a fragment. An e2e flow cannot declare `executionPrerequisite`. Name the start state in the first echo. On Chromium, skip this step and do not pass `executionPrerequisite` (platform file).
3. For a fragment, put the app in the entry state first. Then pass an accurate `executionPrerequisite` that names the screen, the account, and the platform state.
4. Find the first app screen with `describe`. Then record `await-ui-element` with `visible` on one of its stable elements, not on the splash screen.

## Record each action

Go to each screen through the app UI. Do not use `open-url` as a replacement for navigation.

1. Find the element without a change of state: `describe`, the platform discovery tool, `debugger-component-tree`, or `screenshot`. Do not record discovery calls or `debugger-*` calls.
2. Select a stable target (`argent-create-flow` SKILL.md, rule 3).
3. Add an echo with the current state, the action, and the result that must show.
4. Do the action through `flow-add-step`. Read the `recorded` line.
5. When its state shows, record the result check.

### Navigation

After each screen change, record `await-ui-element` with `visible` on an element that is only on the destination screen. A tab bar, a shared header, or a positional id does not identify the screen. If a stable control (not a data value) shows that the data is loaded, record a second wait on it. In the polish pass, add `await: { idle: true }` after the identity check. Go to a fixed destination when possible. A back button or a back swipe pops one stack entry, so its destination can change between visits. If the test is about back navigation, record the tap on the back control or the back swipe. Then check its result like each other screen change.

### Absence

Use the same stable selector in all three steps. Record it as `visible`. Record the action that removes the element. Then record it as `hidden`. Without the first step, `hidden` also passes for a typo or for an element that was not on the screen. The first `visible` check must use an id or exact text, not only a role or a regex. After `hidden`, also check the element that replaces it or the empty state, when there is one.

### Overlays

If an overlay covers the next target, record the overlay as `visible`. Record the dismissal action. Then record the overlay as `hidden`. Only then touch the covered area. An auto-dismiss timer is not a dismissal step. If the app has a test setting that turns off transient overlays, use it. Keep a dismissal swipe only when the UI supports the swipe. Put it through the coordinate fallback gate. Then make sure that the overlay is hidden.

### Taps

Find the element. Then record `gesture-tap` at the center of its frame. The recorder writes a selector from the tree.

Read the `recorded` line. `tap: { id: ... }` or `tap: { text: ... }` is good. `tap: { role: ... }` with no other key is weak, and the recorder gives no warning for it. A kept raw point comes with a warning.

For a weak step, go back to the source screen with direct MCP calls. Record a better tap. Remove the weak step after `flow-finish-recording`. Keep a point or a role only through the [coordinate fallback gate](#coordinate-fallback-gate). Do not tap the on-screen keyboard through the recorder.

### Text entry

Record the focus tap. Then record `keyboard` with `text` (`text` or `key`, not the two). To submit, record a second `keyboard` with `key: "enter"`. Make sure that the field has the full value. Then record a check on the committed value, with a `text` condition or a validation marker. `type:` also passes when its focus was not confirmed. If the field does not show all the characters, correct it with direct calls.

Write a credential as `{{secret:NAME}}`, not as a literal. Do not `describe` or `screenshot` a plain text field that you filled from a secret. Go to the next screen first.

### Scrolls and swipes

Record the live gesture. In the polish pass, convert a movement that finds an element to `scroll-to`, and a movement that is the action to `swipe:`. Keep a system edge swipe raw. Give each kept raw gesture an echo and a result check.

### Nested flows

To record a `run:` step, call `flow-execute` through `flow-add-step`. The top-level `name` is the name of the recording. `args.name` is the sibling flow that becomes `run:`. If the recorder keeps a raw `flow-execute` step, read the warning ([Warnings](warnings.md#capture-warnings)).

### Live waits

Record `await-ui-element` through `flow-add-step`. The recorder writes the step also when `success` is false. Read `success` and `cause`:

- `unmet`: the condition was false. Correct the state, the selector, or the timeout. Record the check again. Remove the failed step after `flow-finish-recording`.
- `unreadable`: the condition is unknown. Repair the tree source. Then record the check again. Keep the failed step.
- `cancelled`: the condition is unknown. Record the check again. Keep the failed step.

Do not remove a step during the recording. A wait in `run-sequence` gets no recorder warning, so read the nested result. The tool schema gives the selector fields. If `message` has a warning about the runner tree, read [Recorded wait warnings](warnings.md#recorded-wait-warnings).

## Coordinate fallback gate

Target sequence: a strict stable id, then narrow stable text or an accessibility label, then a role that is unique on the screen. Use `scroll-to` plus one of these for an off-screen target. Use raw coordinates only after the checks below.

Do the gate when capture keeps a raw point or only a role. Keep the source screen open:

1. Find candidates with the platform discovery tool.
2. Do a test of each candidate in a scratch fragment with `assert: { visible: <candidate> }` on the correct screen. A scratch fragment is a temporary YAML file with an `executionPrerequisite` and only the assert step. Run it with `flow-execute`, an absolute `flow_path`, and `prerequisiteAcknowledged: true`. Then remove it. Examine each failure before you try a better id, label, or container.
3. If the source code is available, look for `testID`, `accessibilityIdentifier`, or `resource-id`. If there is none, report the missing stable id as the correct repair.

An unreadable tree makes the test void. Repair the tree. Then do the test again. Keep coordinates only for an element with no id, text, or label. Also keep them if all candidates fail against a readable tree. Give each kept point an echo and a hard check on the result. Report the point, the discovery results, and each candidate that failed. A QA flow keeps a point only for an element with no label.

## Recovery from an incorrect step

Stop. Go back to the last correct screen with direct MCP calls, not through `flow-add-step`. Continue only from a state that you made sure of. Remove the bad step after `flow-finish-recording`. If the recovery changed or skipped behavior, record that part again.
