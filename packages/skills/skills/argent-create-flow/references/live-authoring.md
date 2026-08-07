# Live authoring

Read this file before creating or changing a flow. Exercise the saved path through the recorder. Perform syntax cleanup only after finishing.

- [Recorder contract](#recorder-contract)
- [Start in the correct order](#start-in-the-correct-order)
- [Record the first walkthrough](#record-the-first-walkthrough)
- [Finish and polish](#finish-and-polish)
- [Worked example](#worked-example)
- [Blocking audit](#blocking-audit)
- [Replay](#replay)

## Recorder contract

`flow-add-step.command` is an MCP tool name. `args` is a JSON string, not an object. Omit `args` for a no-argument tool.

```text
command: "gesture-tap"
args: "{\"udid\":\"DEVICE\",\"x\":0.5,\"y\":0.35}"
```

A recorded `flow-execute` has two names. The top-level `name` identifies the recording. `args.name` identifies the sibling flow captured as `run:`.

Obey these lifecycle rules:

1. Pass the same `name` and absolute `project_root` to every recording tool.
2. Choose a name unique to the task. Another caller can take over the same pair without an ownership check. The pair is keyed by the file the filesystem resolves to, not the spelling you passed, so a differently-cased name or a symlinked `.argent/flows` collides too. That collision is reported: the second start says `restarted`, and the first recording's next call fails naming both spellings.
3. Give concurrent recordings separate devices. Their files are isolated, but their live device actions are not.
4. Treat `flow-start-recording` as destructive. It always truncates the named YAML, including a finished or committed flow. `restarted` reports only a displaced live take.
5. If a call says the recording is inactive, do not restart under that name. The completed take can still be on disk. Copy it aside or record under a fresh name.
6. Inspect `toolResult`, `message`, and `flowFile` after each call. Failed steps are not recorded.
7. Edit or reorder the YAML only after `flow-finish-recording`. An active remote recording can overwrite mid-recording edits.

## Start in the correct order

### iOS, Android, and Vega e2e flows

1. Call `flow-start-recording` before launching or touching the app.
2. Record a plain `restart-app` as the first non-echo action. Pass only the device id and app id. The recorder converts it to `launch:`.
3. Record `await-ui-element` for the real first screen immediately after restart.

Extra restart arguments prevent `launch:` conversion. An Android `activity`, for example, leaves a raw tool step and therefore a fragment.

Do not use splash content as a selector or landmark. Wait for the first real screen.

On iOS, only `restart-app` guarantees an instrumented launch. `launch-app` can foreground an uninstrumented process. Use [iOS selector recovery](reliability-and-recovery.md#ios-selector-recovery) when the tree is missing.

### Chromium e2e flows

Use `1366 × 768` unless the user or test contract specifies another size. Boot a fresh target with `boot-device`, `electronAppPath`, and `electronArgs: ["--window-size=1366,768"]`. Do not record against a target whose size came from host state. Stop if the requested size cannot be honored.

After boot, start the recorder before the first in-app action. Record the first-screen wait. `restart-app` has no Chromium support and only successful calls are recorded, so a recorded Chromium flow is always a fragment: its launch is written in during polish rather than captured, and any `executionPrerequisite` the recording declared must go with it. A launch-first flow must not carry one. During polish, add the matching launch:

```yaml
steps:
  - launch:
      chromium:
        path: ../../app
        args: ["--window-size=1366,768"]
```

The path is relative to `.argent/flows/`. Preserve all live boot arguments and exactly one window-size argument. This packaging exception represents the boot already exercised live. It does not permit a rehearsed UI path.

### Fragments

Stage the entry state before recording. Then start with a precise `executionPrerequisite` that names UI, account, and platform state. Do not store a device id. Start recording before the fragment's first interaction.

## Record the first walkthrough

For Vega, first read [Flow YAML: Composition and platform limits](flow-yaml.md#composition-and-platform-limits). Vega is remote-driven and does not use touch gestures.

Reach each screen through the app's UI. Do not replace tested navigation with `open-url`. Starting the app is not navigation.

For every action:

1. **Discover without mutation.** Use `describe`, iOS native discovery, `debugger-component-tree`, or `screenshot`. Do not record discovery or `debugger-*` calls.
2. **Choose a durable target.** Prefer a stable id, then stable text or an accessibility label. On iOS, use native discovery for ids that trimmed accessibility output omits.
3. **Add an echo.** Name the current state, action, and expected outcome before the action can fail.
4. **Execute through `flow-add-step`.** Inspect the result and returned YAML immediately.
5. **Verify immediately.** Record outcome checks when their states first appear. After navigation, record identity before taking the next action.

### Record identity, then readiness, after every navigation

1. Record `await-ui-element visible` on an element unique to the destination.
2. If a specific control marks application readiness, record another visible wait on that control before the next action.
3. During polish, add `await: { idle: true }` after the identity check.

A shared tab bar, source element, or positional id does not prove navigation. `idle` cannot identify the screen or prove application data is ready. Keep the control wait because asynchronous loading can continue after stillness. If the screen intentionally moves, disclose it and gate the next action on a stable element. Read [Flow YAML: Prove a navigation](flow-yaml.md#prove-a-navigation-identity-then-readiness) for the directive semantics.

### Record absence in three steps

Use the same stable selector for both checks:

1. Record it as `visible`.
2. Record the action that removes it.
3. Record it as `hidden`.

Without step 1, `hidden` also passes for a typo or an element that never existed. A role-only or regex-only first locator does not establish a specific element.

### Taps

Discover the element first. Then record `gesture-tap` at its frame center. The recorder reads the pre-tap tree and stores a strict id or text selector.

If capture keeps the point, stop and read its warning. Restore the source screen with direct MCP calls. Record a corrected tap, then remove the point after finishing. Keep a point only through the [coordinate fallback gate](reliability-and-recovery.md#coordinate-fallback-gate).

Never tap the on-screen keyboard through the recorder. Some platforms expose it as one large node, so replay can tap the wrong key while reporting success. Record text with `keyboard`.

### Typing

Record the focus tap. Use `describe` to confirm focus before recording `keyboard`. Verify the complete value or an app validation marker. Do not expose secure values in screenshots or echoes.

If characters are lost, restore the field with direct calls. Do not record a duplicate typing step. Polish the valid pair into `type:`. The replay focus wait is best effort, so retain a committed-value check. Store credentials as `{{secret:NAME}}`. Never record a literal credential.

### Scrolling and swiping

Record the required live gesture. During polish:

- Convert element-seeking movement to selector-based `scroll-to`.
- Retain a raw swipe only when the gesture itself is under test.

For every retained raw gesture, add an echo and a recorded result check.

### Live waits and checks

Record `await-ui-element` through `flow-add-step`. When its condition is unmet, `toolResult.success` is false and the step is not recorded. Fix the selector or timeout and try again.

The live tool and flow runner use different trees. A live wait can pass while its converted directive cannot resolve. Replay every conversion. Keep the raw tool only when its `pollIntervalMs` or `bundleId` is required. Live tools use `identifier`. Flow YAML uses `id`.

### Wrong turns

Stop immediately. Restore the last valid screen with direct MCP calls, not `flow-add-step`. Continue only from verified state. Remove the bad step after finishing. If recovery changed or skipped meaningful behavior, re-record that portion live.

## Finish and polish

Call `flow-finish-recording`, then read the saved YAML. Apply only meaning-preserving conversions:

| Recorded form                | Finished form                                                      |
| ---------------------------- | ------------------------------------------------------------------ |
| focus tap + `tool: keyboard` | `type:`                                                            |
| keyboard ending in Enter     | submitted `type:` without Enter in its text                        |
| `tool: await-ui-element`     | `await:` or `assert:`                                              |
| element-seeking movement     | `scroll-to:`                                                       |
| coordinate tap or long-press | strict selector after the fallback gate                            |
| `tool: gesture-pinch`        | selector-based `pinch:` with `scale = endDistance / startDistance` |
| `tool: gesture-rotate`       | selector-based `rotate:` with `by = endAngle - startAngle`         |
| sibling `tool: flow-execute` | recorder-captured `run:`                                           |

Only these unrecorded insertions are allowed, at states observed live:

- A planned `snapshot:` for pixel-level evidence.
- `await: { idle: true }` after a navigation identity check.
- The Chromium launch that packages the live boot.

Keep raw forms only when conversion changes behavior. Examples include point-anchored or panning pinch, velocity-sensitive swipe, or rotation with a tested start angle, radius, pivot, duration, or speed. Keep screenshots for human evidence. Use `snapshot:` for automated visual comparison. Read [Flow YAML](flow-yaml.md) for syntax.

If polish reveals a missing action or structural check, restore its preceding state and record it. Do not add remembered behavior directly to YAML.

## Worked example

`FLOW` below abbreviates `name: "open-settings", project_root: "/Users/dev/AcmeNotes"`. Repeat both fields in every call.

```text
flow-start-recording { FLOW }
flow-add-echo { FLOW, message: "Restart Acme Notes; expect Home" }
flow-add-step { FLOW, command: "restart-app", args: "{\"udid\":\"ABC\",\"bundleId\":\"com.acme.notes\"}" }
# captured as: - launch: com.acme.notes
flow-add-step { FLOW, command: "await-ui-element", args: "{\"udid\":\"ABC\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"home-screen\"}}" }
flow-add-echo { FLOW, message: "On Home; open Settings" }
flow-add-step { FLOW, command: "gesture-tap", args: "{\"udid\":\"ABC\",\"x\":0.91,\"y\":0.94}" }
# pre-tap capture resolves to: - tap: { id: settings-tab }
flow-add-step { FLOW, command: "await-ui-element", args: "{\"udid\":\"ABC\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"settings-screen\"}}" }
flow-finish-recording { FLOW }
```

After meaning-preserving conversion:

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

## Blocking audit

Run these checks before replay:

```text
# Coordinates and raw gestures
rg -n '(\{ *x:|^ +(x|centerX|fromX|toX):|gesture-(tap|swipe|scroll|drag|pinch|rotate|custom))' .argent/flows/<name>.yaml
# Stored device ids
rg -n '(udid|device_id)' .argent/flows/<name>.yaml
# Positional ids and loose condition selectors
rg -n '(-selector-\d+|selector-\d+\b)' .argent/flows/<name>.yaml
rg -n '(await|assert):.*(visible|hidden|exists) *: *["'"'"'A-Za-z0-9]' .argent/flows/<name>.yaml
# Fixed waits and skipped navigation
rg -n '^\s*- wait:|open-url' .argent/flows/<name>.yaml
```

Resolve every hit and confirm:

- Every element action uses a stable selector unless the fallback gate cleared and documented it.
- Every element-seeking gesture became `scroll-to`.
- No device id or literal credential remains.
- Every selector-bearing condition uses an explicit selector map without positional or data-derived values.
- Every fixed wait has an echo and a following hard check. Prefer a condition or `idle`.
- No `open-url` replaces tested navigation.
- Every snapshot is intentional, deterministic, non-mutating, and ready for reviewed baseline creation.
- The e2e launch and real first-screen gate are present. Only Chromium permits an inserted launch.
- Every screen change has a destination-only identity check and an `idle` readiness check.
- Every `hidden` check follows a `visible` check on the same stable selector and the removing action.

## Replay

Run `flow-execute` on the complete YAML with the absolute project root. For a fragment, verify its prerequisite before setting `prerequisiteAcknowledged: true`.

`flow-execute` takes exactly one flow source: `name`, for a flow saved under `.argent/flows/`, or `flow_path`, an absolute path to any flow `.yaml`. `run:` targets and baselines resolve on the tool server's filesystem, beside the YAML it actually reads. `flow_path` therefore requires the agent and the tool server to share a filesystem and is refused when they do not. `name` still runs remotely, but the server receives only that one YAML in a fresh temp directory, so a `run:` target fails as a missing fragment and a `snapshot` fails for a missing baseline. Replay self-contained flows remotely; a composing or snapshotting flow needs one shared filesystem.

Manual rescue invalidates the pass. An `errored` step is an environment failure, not an app verdict. Fix the environment and rerun. Inspect every passing step with a warning, disclose the cause, and ensure the next action uses a stable gate.

One uninterrupted full pass completes a normal flow. `argent-qa-flows` requires two consecutive passes of unchanged YAML. For CI, use `argent flow run <name> [--platform ...]`.
