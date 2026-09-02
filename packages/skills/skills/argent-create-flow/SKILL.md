---
name: argent-create-flow
description: Create, record, edit, replay, or repair reusable Argent flow YAML files. Use when the user asks to record or replay a repeatable device path, set up profiling or an A/B comparison, or invoke the authoring engine behind argent-qa-flows. Also use before repeating three or more interactions. Supports iOS, Android, and Chromium. For one-off UI checks, acceptance-driven regression tests, or screen video, use argent-test-ui-flow, argent-qa-flows, or argent-screen-recording respectively.
---

# Create an Argent flow

A flow is a list of steps in `.argent/flows/<name>.yaml` that Argent can replay. Flows run on iOS, Android, and Chromium. This skill does not record or author flows for Vega, Apple TV, or Android TV at this time. The runtime replays a hand-written Vega flow with `argent flow run --platform vega`. If the device is a TV, tell the user. Then stop.

If the task is a QA test case, a ticket, or an acceptance criterion, load `argent-qa-flows` first.

## Read in this sequence

1. Bind one device with `list-devices`. Then read the platform file one time: [iOS](references/platforms/ios.md), [Android](references/platforms/android.md), or [Chromium](references/platforms/chromium.md). Only the platform file gives the platform behavior.
2. Read the file for your phase:
   - Record a new flow, or record steps again: [Record](references/record.md).
   - Convert the recorded YAML: [Polish](references/polish.md) and [Flow YAML](references/yaml.md).
   - Audit before each replay: [Polish: Audit](references/polish.md#audit).
   - Replay or repair a flow: [Replay](references/replay.md).
3. If a tool result or a replay report contains a warning, read [Warnings](references/warnings.md).

## Rules

1. **Record the first walkthrough.** Start the recorder before the first launch or app action. Do not write steps from memory. Before you do three or more interactions again, tell the user. Then start a recording.
2. **When its state shows, record the check.** Record `await-ui-element` live. An echo gives context. A screenshot is evidence for a person. The two are not verdicts.
3. **Use stable targets.** Use an id first, then stable text or an accessibility label. A stable target comes from the app code. It does not change with the account, data, time, count, sequence, locale, or environment. Do not use values such as `Today`, `Item 4`, a user name, a counter, or a timestamp. A value that the action changes, such as a counter after a tap, is a result check, not a target. If capture keeps a raw point or only a role, do the [coordinate fallback gate](references/record.md#coordinate-fallback-gate).
4. **Show each screen change.** Record a check on an element that is only on the destination screen. Add `await: { idle: true }` after it in the polish pass. A screen that does not move does not show which screen it is.
5. **Convert only recorded behavior.** You can remove a step or correct a parameter by hand. You can add by hand only the [steps that you can add by hand](references/polish.md#steps-that-you-can-add-by-hand). Record a missing action or check live.
6. **Replay the complete YAML from start to end.** One full pass with no manual help completes a flow. Two passes, one after the other, are necessary for `argent-qa-flows`.

### Flow-only selector scopes

In the polish pass, use `within`, `after`, and `next` to select one of some equal elements. Read [Flow YAML: Relational scopes](references/yaml.md#relational-scopes).

## Workflow

1. Select the flow type. An **e2e** flow starts with `launch:`. A **fragment** has no launch at the start and declares an `executionPrerequisite`. If the app has no control for the action in the task, report it. Then stop.
2. Do the record, polish, audit, and replay phases. Each phase file gives the steps.
3. Report the file, the replay command (`argent flow run <name>`), the result, the prerequisite or side effects, and each coordinate or raw-gesture step that you kept. At the end of the session, call `stop-all-simulator-servers` with `devices: [<this device>]`.

## Repair

If a replay fails, report the first failed step. If the task asks for a flow that passes, repair it as [Replay](references/replay.md) tells you. Do not make a check that the task specifies weaker to get a pass.
