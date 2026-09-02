# Warnings

Read this file when a tool result or a replay report contains a warning. A warning does not reject a step. Find which warning it is. Then do the action for it.

## Capture warnings

The recorder kept raw coordinates for a tap. If the warning shows a tree error, the tree was unreadable. Repair the tree (platform file). Then record the tap again. For all other causes, do the [coordinate fallback gate](record.md#coordinate-fallback-gate). A `tap: { role: ... }` with no other key gets no warning. Do the same for it.

A warning that starts `kept the raw flow-execute step` means that the recorder did not write `run:`. The message names the cause. Correct it. Then record the call again. The fallback gate does not apply to it.

## Recorded wait warnings

`flow-add-step` and `flow-finish-recording` give a warning about a recorded `await-ui-element`:

- The live wait failed. Read `cause` ([Record: Live waits](record.md#live-waits)).
- The condition did not hold on the runner tree. Make sure that the screen did not change. For `text`, make sure that the selector matches only one element. Then do the remedy that the warning message gives. The remedy for `hidden` is opposite to the remedy for the other conditions, so read it, do not guess. Prove the correction with `flow-execute`.
- The runner tree was slow. The conversion is unknown. Convert the wait and replay the flow, which has no read time limit. Do not record the wait again and again.
- The runner tree was unreadable, or the check was cancelled. Repair the tree source (platform file). Then record the wait again.

An edit of the YAML during the recording drops these warnings. If `flow-finish-recording` reports dropped warnings, record those waits again.

## Idle warnings

`await: { idle: true }` does not fail a run. Each result other than a clean settle passes with one of these warnings:

- **The screen did not stop.** A video, a shimmer, or a carousel is healthy. A load that did not finish looks the same. Look at the screen. Make sure that the next step targets a stable element.
- **A small part continued to move.** A spinner, a caret, or a progress dot moved. Look at the screen.
- **The screen did not move for the last N ms.** The wait ran out during the hold. Increase the `timeout:` of this step.
- **The tree stayed empty.** The screen had no accessible content. Make sure that the screen is shown.
- **Settled on the UI tree alone.** The runner could not read a screenshot pair. Examine the capture path.
- **Too few reads.** The step ended with no evidence. Increase the `timeout:` of this step, and gate the next action on a stable element.

One result stops the run: the runner could not read the tree at all. The step is `errored`, and the runner does not do the subsequent steps. Repair the tree source (platform file). Increase the `timeout` before you think that the app has a defect. Report each idle warning that you accept, with its cause.

## Selector-less gesture warning

A coordinate `tap`, `long-press`, or `swipe`, or a `pinch` or `rotate` without `on:`, passes with a warning when the tree is unreadable. The runner sent the gesture, but there is no proof that it touched the element. Repair the tree source, usually with a relaunch of the app. Accept the warning only for an app with no tree ([iOS: System apps](platforms/ios.md#system-apps)). Put a `wait:` before a gesture that follows a screen change.
