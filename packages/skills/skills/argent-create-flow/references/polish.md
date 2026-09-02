# Polish

Read this file after `flow-finish-recording`. Convert the recorded steps without a change of meaning. For the syntax, read [Flow YAML](yaml.md).

## Finish

1. Call `flow-finish-recording`. Read the YAML at `path`.
2. Read each `warning:` line in `summary`. Do the action in [Warnings](warnings.md).
3. If `message` reports dropped warnings, record those waits again.

## Convert the steps

| Recorded form                             | Finished form                                       |
| ----------------------------------------- | --------------------------------------------------- |
| focus tap + `tool: keyboard`              | `type:`                                             |
| text `keyboard` + `key: enter` `keyboard` | `type:` with the default submit, no Enter in `text` |
| `tool: await-ui-element`                  | `await:` or `assert:`                               |
| a movement that finds an element          | `scroll-to:`                                        |
| a movement that is the action             | `swipe:` ([Flow YAML: Swipe](yaml.md#swipe))        |
| a coordinate tap or long-press            | a strict selector, after the fallback gate          |
| `tool: gesture-pinch`                     | `pinch:` with `scale = endDistance / startDistance` |
| `tool: gesture-rotate`                    | `rotate:` with `by = endAngle - startAngle`         |
| sibling `tool: flow-execute`              | `run:` (recorded, or a raw step with a warning)     |

- Write the recorded `selector:` map into the condition. Do not write a bare string. `identifier` and `id` are the same field, and you can rename it to `id`. A converted `await:` gets the flow default timeout (7500 ms) unless you copy `timeoutMs` to `timeout`.
- If the recorder wrote `text:` for an element that has a stable id, change the selector to the id. The replay proves it.
- Convert `textMatch: equals` to `equals:`. Convert other text checks to `contains:`.
- A focus tap plus one text-only `keyboard` call becomes `type:` with `submit: false`.
- In a `swipe:`, anchor `from` on the subject of the gesture, such as the card that you dismiss. Do not anchor it on the content below the finger.
- If the conversion changes the behavior, keep the raw tool step. Examples are a point-anchored pinch, a system edge swipe, a multi-touch `gesture-custom`, and a rotation with a tested start angle. A wait with `pollIntervalMs` or `bundleId` also stays raw.
- Keep screenshots as evidence for a person. Use `snapshot:` when the runner must compare the screens.
- Replay the full flow after the conversion ([Replay](replay.md)).

## Steps that you can add by hand

You can add only these steps by hand, at states that you saw live:

- A planned `snapshot:`.
- `await: { idle: true }` after each identity check, also after the first-screen check that follows `launch:`.
- A `long-press:` on an element that you long-pressed live. No tool records one, so add it and prove it with the replay.
- A `when:` block around recorded optional steps. Record the steps first. Then wrap them, and prove the two paths with the replay.
- A `wait:` before a gesture that follows a screen change. Give it an echo and a hard check after it.
- The Chromium `launch:` (platform file).

If the polish pass shows a missing action or check, go back to the state before it. Then record it.

## Example

`FLOW` is `name: "open-settings", project_root: "/Users/dev/AcmeNotes"`. Give the two fields again in each call.

```text
flow-start-recording { FLOW }
flow-add-echo { FLOW, message: "Restart Acme Notes. Expect Home" }
flow-add-step { FLOW, command: "restart-app", args: "{\"udid\":\"ABC\",\"bundleId\":\"com.acme.notes\"}" }
flow-add-step { FLOW, command: "await-ui-element", args: "{\"udid\":\"ABC\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"home-screen\"}}" }
flow-add-echo { FLOW, message: "On Home. Open Settings" }
flow-add-step { FLOW, command: "gesture-tap", args: "{\"udid\":\"ABC\",\"x\":0.91,\"y\":0.94}" }
flow-add-step { FLOW, command: "await-ui-element", args: "{\"udid\":\"ABC\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"settings-screen\"}}" }
flow-finish-recording { FLOW }
```

After conversion:

```yaml
steps:
  - echo: Restart Acme Notes. Expect Home
  - launch: com.acme.notes
  - await: { visible: { id: home-screen } }
  - await: { idle: true }
  - echo: On Home. Open Settings
  - tap: { id: settings-tab }
  - await: { visible: { id: settings-screen } }
  - await: { idle: true }
```

## Audit

Run these searches before the replay (`rg`, or `grep -nE` if `rg` is not installed):

```text
rg -n '(\{ *x:|^ +(x|centerX|fromX|toX):|gesture-(tap|swipe|scroll|drag|pinch|rotate|custom))' .argent/flows/<name>.yaml
rg -n -B2 '^ +role:|\{ *role: *[^,}]+ *\}' .argent/flows/<name>.yaml
rg -n '(udid|device_id|serial|devices:)' .argent/flows/<name>.yaml
rg -n '(-selector-[0-9]+|selector-[0-9]+\b)' .argent/flows/<name>.yaml
rg -n '(visible|hidden|exists) *: *["'"'"'A-Za-z0-9]' .argent/flows/<name>.yaml
rg -n '^\s*- wait:|open-url' .argent/flows/<name>.yaml
```

Examine each hit and correct the incorrect ones. Then make sure that:

- Each action uses a stable selector, or the fallback gate let it through and you documented the step.
- No `tap:` or `long-press:` has `role:` as its only key, unless the fallback gate let it through and you documented the step.
- Each movement that finds an element is `scroll-to`.
- No device id or literal credential is in the file. The `devices:` list of a recorded `stop-all-simulator-servers` stays. Do not remove it.
- Each condition and `when:` guard uses a selector map without positional or data-derived values.
- Each `wait:` has an echo and a hard check after it. No `open-url` replaces navigation.
- Each `snapshot:` is planned, deterministic, and does not change state.
- An e2e flow has its launch and a check on the first app screen.
- Each screen change has an identity check and `await: { idle: true }`. Record a missing identity check live. Add a missing `idle` in the YAML.
- Each `hidden` check comes after a `visible` check on the same selector and the action that removes the element.
