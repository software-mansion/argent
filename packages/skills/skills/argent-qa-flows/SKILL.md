---
name: argent-qa-flows
description: Create repeatable QA regression E2E tests as Argent flows from test cases, tickets, or acceptance criteria. Use when the user asks to generate or preserve an automated regression scenario, with deterministic setup, stable targets, executable structural or visual evidence, and two consecutive full passes. For one-off UI checks or replayable paths without acceptance criteria, use argent-test-ui-flow or argent-create-flow. Supports iOS, Android, and Chromium. Vega, Apple TV, and Android TV are not supported at this time.
---

# Create a QA regression flow

Load `argent-create-flow` as the authoring engine. Read its platform file first, and each phase file when that phase starts. This skill adds the QA contract and the completion gate. QA flows run on iOS, Android, and Chromium. If the device is a TV, tell the user that QA flows are not supported there at this time. Then stop.

## Definition of done

A QA flow is complete only when:

1. The first step after an echo is `launch:` (on Chromium, the launch that you add in the polish pass). In-flow setup shows a deterministic data baseline. Subsequent runs do not collect data, and manual cleanup is not necessary.
2. The first walkthrough recorded each action and each structural check live. Only the [steps that you can add by hand](../argent-create-flow/references/polish.md#steps-that-you-can-add-by-hand) are unrecorded.
3. Each requirement maps to a hard `await:`, `assert:`, or examined `snapshot:`. Echoes and screenshots are not verdicts.
4. Each screen change has an identity check and then `await: { idle: true }`.
5. Each target obeys the stable-selector rule and the coordinate fallback gate. A QA flow keeps a coordinate only for an element with no label.
6. The unchanged YAML passes two times with the same runner. Pass 1 starts with restarted Argent services on iOS or Android, or with a run that boots its own instance on Chromium. Pass 2 follows immediately.

## 1. Write the test contract

Before you touch the app, write a compact table. Put it in the report at the end too. Include:

- The app, the platform, and the named start state.
- The user actions, in sequence.
- One row for each result that must show, persistence rule, or absence claim.
- Stable executable evidence for each row.
- The necessary data and the side effects.

Use structural checks for semantic state and snapshots for pixels. One behavior scenario is one `qa-<area>-<behavior>` flow. Do not invent a material value. If an ambiguity changes the meaning of the test, get a decision from the user. If not, select the strongest reading that the UI can show. Report it.

Make repeated runs deterministic. Examine the baseline without a change of state. If the account is dirty, put a safe normalization in the setup. Or record a safe reset or seed flow, then record a `flow-execute` of it (the recorder writes `run:`). After the setup navigation, echo the baseline. Then make sure of it with `assert:` or a destination `await:` before the first mutation. If possible, put the baseline back at the end. Get approval before a cleanup that makes or erases user data that the task does not include.

### Example

Ticket: select Dark in Settings. Dark is selected, Light is absent, and the screen renders in dark mode.

| Contract row      | Action                     | Evidence                                                                    | State effect          |
| ----------------- | -------------------------- | --------------------------------------------------------------------------- | --------------------- |
| Signed-in Home    | Launch                     | `await: { visible: { id: home-screen } }`, then `await: { idle: true }`     | Existing account      |
| Open Settings     | Tap `settings-tab`         | `await: { visible: { id: settings-screen } }`, then `await: { idle: true }` | None                  |
| Light is selected | Examine Settings           | `assert: { visible: { id: theme-light-selected } }`                         | Fails if Dark is set  |
| Dark is selected  | Tap `theme-dark-option`    | `await: { visible: { id: theme-dark-selected } }`                           | Theme becomes Dark    |
| Light is absent   | Examine the settled screen | `assert: { hidden: { id: theme-light-selected } }`                          | None                  |
| Dark rendering    | Examine the settled screen | `snapshot: settings-dark`                                                   | None                  |
| Baseline is back  | Tap `theme-light-option`   | `await: { visible: { id: theme-light-selected } }`                          | Next run starts clean |

The first Light check establishes the selector for the subsequent `hidden` check. The last row lets pass 2 run without manual cleanup.

## 2. Record the scenario

Do the create-flow [Start](../argent-create-flow/references/record.md#start) and [Record each action](../argent-create-flow/references/record.md#record-each-action) procedures. When its state shows, record each structural contract check. A snapshot has no recorder form. Examine its stable state during the walkthrough. Add the planned snapshot in the polish pass. If a direct recovery changes state, record that behavior again. A walkthrough with a recovery is not proof.

## 3. Make the evidence specific

- **State change:** show the new state. When the two can match, also show that the previous state is not shown.
- **Cancel or persistence:** go across the commit boundary. After cancel or save, go out of the screen. Go into it again. Then make sure of the kept state.
- **Absence:** show the screen that contains the element. Record the same selector as `visible`, then the action, then `hidden`. In a collection, absence in the viewport is not global absence. Use a fixed seeded position, a count, or an empty state.
- **Repeated controls:** use an id. If there is none, use a `visible` condition with `text` and `within` on a stable container. `text.in` reads one element, so it is not a membership check.
- **Dynamic content:** assert controlled state or stable app chrome. Use an anchored regex for an unavoidable dynamic value and report the dependency.
- **Visual state:** snapshot only a correct, settled, deterministic screen. Use the full screen for global changes and `cropOn` for one component.

Do not put acceptance evidence in `when:`.

## 4. Finish and audit

Do the create-flow polish pass and audit. Then map each contract row to a recorded action or a hard check. Make sure that the setup and the end state let a second run start immediately.

Write a navigation table with one row for each screen change, with the identity check and the readiness check. A row without one of them is a defect. The flow is not complete until you correct it. Record a missing identity check live. Add a missing `idle` in the YAML.

| Action             | Destination | Identity                  | Readiness |
| ------------------ | ----------- | ------------------------- | --------- |
| Tap `settings-tab` | Settings    | `settings-screen` visible | `idle`    |

## 5. Two passes in a row

After the last edit and audit, set the streak to zero:

1. Select one runner for the two passes: `flow-execute`, or `argent flow run <name> --device <device>` for CI (on Chromium, `--platform chromium` and no `--device`). A change of runner resets the streak.
2. Write and examine the snapshot baselines. Then freeze them. A baseline update is not a pass.
3. Before pass 1 on iOS or Android, call `stop-all-simulator-servers` with `devices: [<device>]`, or `argent run stop-all-simulator-servers --devices <device>` from the standalone runner. A call without `devices` stops the devices of all agents on this machine. The restart must not change app or account data. On Chromium, do not call `stop-all-simulator-servers`. The runner boots its own instance, and the run gets no `device` argument (platform file).
4. Run from the launch, without baseline-update mode. When the report shows `PASS` and each acceptance check ran, count a pass. An `errored` step does not increase the streak. If the step could not run, repair the environment. Then run again. A failed `launch:` is a verdict about the app. Report it.
5. Read [Warnings](../argent-create-flow/references/warnings.md) for each warning. Resolve it, or accept it when that file says so. Report each accepted warning with its cause.
6. Run the same YAML again immediately with the same runner. Do not reset app or account data by hand.
7. Reset the streak after a failure, an edit, a new recording, or a baseline update. Also reset it after a manual recovery that changes state. Repair through `argent-create-flow`. Audit again ([Audit](../argent-create-flow/references/polish.md#audit)). Then start again with restarted services.

When the streak is two, finish. If the intended runner is not available, report that the proof is blocked. If the app fails, keep the check. Report the regression.

## 6. Report

Report the flow name, path, platform, and standalone command. Report the contract rows mapped to actions and checks, and the navigation table. Report the baseline setup, the end-state restoration, and the accepted data dependencies. Report the two pass results, the runner, the service-restart setup, the resolved warnings, and each accepted warning with its cause. Report the snapshot scope, the examined baseline status, and the mismatch tolerance. Report each coordinate or raw-gesture step that you kept, and each manual decision or problem that stays.
