# Live authoring

Read this file before creating or changing an e2e test. Exercise the saved path through the recorder. Perform syntax cleanup only after finishing.

- [Live authoring](#live-authoring)
  - [Recorder contract](#recorder-contract)
  - [Start in the correct order](#start-in-the-correct-order)
    - [iOS, Android, and Vega standalone tests](#ios-android-and-vega-standalone-tests)
    - [Chromium standalone tests](#chromium-standalone-tests)
    - [Fragments](#fragments)
  - [Record the first walkthrough](#record-the-first-walkthrough)
    - [Record identity, then readiness, after every navigation](#record-identity-then-readiness-after-every-navigation)
    - [Record absence in three steps](#record-absence-in-three-steps)
    - [Taps](#taps)
    - [Typing](#typing)
    - [Scrolling and swiping](#scrolling-and-swiping)
    - [Live waits and checks](#live-waits-and-checks)
    - [Wrong turns](#wrong-turns)
  - [Finish and polish](#finish-and-polish)
  - [Worked example](#worked-example)
  - [Blocking audit](#blocking-audit)
  - [Replay](#replay)

## Recorder contract

A recorded `e2e-execute` has two names. The top-level `name` identifies the recording. `args.name` identifies the sibling test captured as `run:`.

Over a link, `e2e-add-step` refuses a call whose step a replay over the same link rejects, and runs nothing. It also refuses an `e2e-execute` call whose test does not pass. That test can have changed the device before it stopped. In both cases the recorder records no step. See [Replay](#replay) for the steps that a replay over a link rejects.

Obey these lifecycle rules:

1. Choose a name unique to the task: another caller can take over the same `name` + `project_root` pair without an ownership check. The pair is keyed by the file the filesystem resolves to, not the spelling you passed, so a differently-cased name or a symlinked `.argent/e2e` collides too. That collision is reported: the second start says `restarted`, and the first recording's next call fails naming both spellings.
2. Treat `e2e-start-recording` as destructive. It truncates the named YAML even when it holds a finished or committed test. `restarted` reports only a displaced live take.
3. If a call says the recording is inactive, do not restart under that name. The completed take can still be on disk. Copy it aside or record under a fresh name.
4. Read `recorded` after each call. The recorder does not always store the tool call you made, and that line is where a rewrite shows up. A call that returns normally while reporting an unmet condition **does** append the step; `await-ui-element` is the case that turns up in practice (see [Live waits and checks](#live-waits-and-checks)). To see the whole file mid-recording, read it at `savedTo`. A `null` `savedTo` means only the write on your side failed: the step is still in the recording, the next step rewrites the whole file, and `e2e-finish-recording` returns `flowFile` regardless.
5. Edit or reorder the YAML only after `e2e-finish-recording`.

## Start in the correct order

### iOS, Android, and Vega standalone tests

1. Call `e2e-start-recording` before launching or touching the app.
2. Record a plain `restart-app` as the first action that is neither an echo nor a script. Pass only the device id and app id. The recorder converts it to `launch:`.
3. Record `await-ui-element` for the real first screen immediately after restart.

Extra restart arguments prevent `launch:` conversion. An Android `activity`, for example, leaves a raw tool step and therefore a fragment. On iOS, `launchArgs` is the exception: it records as `launch: { native: <app id>, ios: { app, args } }`.

Do not use splash content as a selector or landmark. Wait for the first real screen.

On iOS, only `restart-app` guarantees an instrumented launch. `launch-app` can foreground an uninstrumented process. Use [iOS selector recovery](reliability-and-recovery.md#ios-selector-recovery) when the tree is missing.

### Chromium standalone tests

**The app sets the window size; no boot argument overrides it.** Electron ignores `--window-size`: the size comes from the app's own `BrowserWindow` options, and Argent never resizes the window. Boot a fresh target with `boot-device` and `electronAppPath`, then take one `screenshot` and record its pixel dimensions: that capture size is the snapshot device class ([E2E YAML: Snapshots](e2e-yaml.md#snapshots-and-cli-runs)) and must match when CI replays. If the app sizes its window from host or session state, say so in the report.

After boot, start the recorder before the first in-app action. Record the first-screen wait. `restart-app` has no Chromium support, so a recorded Chromium test is a fragment until polish writes its launch in (and removes any `executionPrerequisite` the recording declared). During polish, add the matching launch:

```yaml
steps:
  - launch:
      chromium:
        path: ../../app
        args: ["--enable-feature-flag"]
```

A relative path resolves from the folder of the test being run. Copy the live boot arguments verbatim, and omit `args` when the boot passed none. This packaging exception represents the boot already exercised live. It does not permit a rehearsed UI path.

### Fragments

Stage the entry state before recording. Then start with a precise `executionPrerequisite` that names UI, account, and platform state. Do not store a device id. Start recording before the fragment's first interaction.

## Record the first walkthrough

For Vega, first read [E2E YAML: Composition and platform limits](e2e-yaml.md#composition-and-platform-limits). Vega is remote-driven and does not use touch gestures.

Reach each screen through the app's UI. Do not replace tested navigation with `open-url`. Starting the app is not navigation.

For every action:

1. **Discover without mutation.** Use `describe`, iOS native discovery, or `screenshot`. Do not record discovery or `debugger-*` calls: `port` is not a device-bind key, so a recorded one replays against whatever Metro owns that port.
2. **Choose a durable target.** Prefer a stable id, then stable text or an accessibility label. On iOS, use native discovery for ids that trimmed accessibility output omits; on Android React Native, `debugger-component-tree`.
3. **Add an echo.** Name the current state, action, and expected outcome before the action can fail.
4. **Execute through `e2e-add-step`.** Inspect the result and the `recorded` line immediately.
5. **Verify immediately.** Record outcome checks when their states first appear. After navigation, prove identity then readiness: record the identity check live, and add the readiness gate during polish.

### Record identity, then readiness, after every navigation

1. Record `await-ui-element visible` on an element unique to the destination.
2. If a specific control marks application readiness, record another visible wait on that control before the next action.
3. During polish, add `await: { idle: true }` after the identity check.

A shared tab bar, source element, or positional id does not prove navigation. `idle` cannot identify the screen or prove application data is ready. Keep the control wait because asynchronous loading can continue after stillness. If the screen intentionally moves, disclose it and gate the next action on a stable element. Read [E2E YAML: Prove a navigation](e2e-yaml.md#prove-a-navigation-identity-then-readiness) for the directive semantics.

### Record absence in three steps

Use the same stable selector for both checks:

1. Record it as `visible`.
2. Record the action that removes it.
3. Record it as `hidden`.

Without step 1, `hidden` also passes for a typo or an element that never existed. A role-only or regex-only first locator does not establish a specific element.

### Taps

`e2e-add-step` cannot receive a YAML selector directly. Discover the element first, then record `gesture-tap` at its frame center; the live coordinates are transport for the gesture, not a final locator. The recorder reads the pre-tap tree and derives the selector in a fixed order (`id`, then `text`, then `role`), giving three outcomes. Read the `recorded` line after every tap. It names the derived form (a selector map, or the kept point):

1. **`tap: { id: ... }` or `tap: { text: ... }`**: the good case.
2. **`tap: { role: ... }`, with a warning.** An icon-only button with neither id nor visible label lands here. `role` matches as a case-insensitive substring, so a replay screen holding a second control of that role can win the [ranking](e2e-yaml.md#the-runner-tree-is-not-the-discovery-tree) and the tap reports a pass on the wrong control.
3. **A kept raw point**, with a warning naming the reason and the retarget.

Treat outcomes 2 and 3 alike. Restore the source screen with direct MCP calls, record a corrected tap, then remove the weak step after finishing. Keep a point or a bare role only through the [coordinate fallback gate](reliability-and-recovery.md#coordinate-fallback-gate).

Never tap the on-screen keyboard through the recorder. Some platforms expose it as one large node, so replay can tap the wrong key while reporting success. Record text with `keyboard`.

### Typing

Record the focus tap, then record `keyboard` with `text`. To submit, record a second `keyboard` step with `key: "enter"`. Verify the complete value with `describe` or an app validation marker.

**Never `describe` or `screenshot` a non-secure field you just filled from `{{secret:…}}`.** Only a password field is redacted; a plain text input hands the resolved value back into your context, and an API key or token typed into one is the ordinary case. Submit or navigate away first, then verify the resulting screen.

**`describe` marks the field being typed into as `focused` on Chromium and the iOS simulator.** There, read it before recording `keyboard`. Elsewhere, the value check afterwards is what proves the keys landed.

If characters are lost, restore the field with direct calls. Do not record a duplicate typing step. Polish the valid pair into `type:`. Its replay focus wait reads the runner's own tree, which does report focus on iOS, Android, and Chromium, but an unconfirmed poll falls through to typing rather than failing, so retain the committed-value check. Store credentials as `{{secret:NAME}}`. Never record a literal credential.

### Scrolling and swiping

Record the required live gesture. During polish:

- Convert element-seeking movement to selector-based `scroll-to`.
- Convert a swipe that is a gesture in its own right - swipe-to-dismiss, paging a carousel, revealing a row action - to `swipe:`, anchoring `from` on the gesture's **subject** (the card being dismissed, the row being revealed), not on whatever content happened to be under the finger.
- Retain a raw gesture tool only for what `swipe` deliberately doesn't express - an edge swipe (system back), a multi-touch `gesture-custom`, or exotic velocity control.

For every retained raw gesture, add an echo and a recorded result check.

### Live waits and checks

Record `await-ui-element` through `e2e-add-step`. The recorder writes the step even when `toolResult.success` is false, and its warning names the cause and what to do. Delete a failed wait only when the cause is `unmet`, after `e2e-finish-recording`; never during the recording.

A stale `hidden` whose selector matches nothing replays as a silent pass: the unfalsifiable gate that [Record absence in three steps](#record-absence-in-three-steps) exists to prevent. Never proceed as though the gate passed.

The live tool and e2e runner use [different trees](e2e-yaml.md#the-runner-tree-is-not-the-discovery-tree). After a successful wait, the recorder checks the same condition on the runner tree and warns when it does not hold there or could not be checked; the warning says what to rule out. If the trees really differ, keep the raw `await-ui-element` step: it replays on the tree it passed on.

A warning does not reject the step. If `e2e-finish-recording` reports dropped warnings, record those waits again. Replay every conversion. Keep a raw tool only for `pollIntervalMs`, `bundleId`, or a cross-tree mismatch.

### Wrong turns

Stop immediately. Restore the last valid screen with direct MCP calls, not `e2e-add-step`. Continue only from verified state. Remove the bad step after finishing. If recovery changed or skipped meaningful behavior, re-record that portion live.

## Finish and polish

Call `e2e-finish-recording`, then read the saved YAML. Apply only meaning-preserving conversions:

| Recorded form                              | Finished form                                                      |
| ------------------------------------------ | ------------------------------------------------------------------ |
| focus tap + `tool: keyboard`               | `type:`                                                            |
| text `keyboard` + `key: enter` `keyboard`  | submitted `type:` without Enter in its text                        |
| `tool: await-ui-element`                   | `await:` or `assert:`                                              |
| element-seeking movement                   | `scroll-to:`                                                       |
| `tool: gesture-swipe` as the action itself | `swipe:` with `from` on the gesture's subject                      |
| coordinate tap or long-press               | strict selector after the fallback gate                            |
| `tool: gesture-pinch`                      | selector-based `pinch:` with `scale = endDistance / startDistance` |
| `tool: gesture-rotate`                     | selector-based `rotate:` with `by = endAngle - startAngle`         |
| sibling `tool: e2e-execute`                | recorder-captured `run:`                                           |

Copy the recorded `selector:` map when you convert a wait. Do not use the loose bare-string form. E2E YAML accepts `identifier`; rename it to `id` only for style. Convert `textMatch: equals` to `equals:` and other text checks to `contains:`.

Only these unrecorded insertions are allowed, at states observed live:

- A planned `snapshot:` for pixel-level evidence.
- `await: { idle: true }` after a navigation identity check.
- The Chromium launch that packages the live boot.

Keep raw forms only when conversion changes behavior. Examples include point-anchored or panning pinch, an edge swipe or one with exotic velocity control, or rotation with a tested start angle, radius, pivot, duration, or speed. Keep screenshots for human evidence. Use `snapshot:` for automated visual comparison. Read [E2E YAML](e2e-yaml.md) for syntax.

If polish reveals a missing action or structural check, restore its preceding state and record it. Do not add remembered behavior directly to YAML.

## Worked example

`TEST` below abbreviates `name: "open-settings", project_root: "/Users/dev/AcmeNotes"`. Repeat both fields in every call.

```text
e2e-start-recording { TEST }
e2e-add-echo { TEST, message: "Restart Acme Notes; expect Home" }
e2e-add-step { TEST, command: "restart-app", args: "{\"udid\":\"ABC\",\"bundleId\":\"com.acme.notes\"}" }
# captured as: - launch: com.acme.notes
e2e-add-step { TEST, command: "await-ui-element", args: "{\"udid\":\"ABC\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"home-screen\"}}" }
e2e-add-echo { TEST, message: "On Home; open Settings" }
e2e-add-step { TEST, command: "gesture-tap", args: "{\"udid\":\"ABC\",\"x\":0.91,\"y\":0.94}" }
# pre-tap capture resolves to: - tap: { id: settings-tab }
e2e-add-step { TEST, command: "await-ui-element", args: "{\"udid\":\"ABC\",\"condition\":\"visible\",\"selector\":{\"identifier\":\"settings-screen\"}}" }
e2e-finish-recording { TEST }
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
# Weak targets: coordinates, raw gestures, role-only selectors
rg -n '(\{ *x:|^ +(x|centerX|fromX|toX):|gesture-(tap|swipe|scroll|drag|pinch|rotate|custom))' .argent/e2e/<name>.yaml
rg -n -B2 '^ +role:' .argent/e2e/<name>.yaml
# Stored device ids
rg -n '(udid|device_id)' .argent/e2e/<name>.yaml
# Positional ids and loose condition selectors
rg -n '(-selector-\d+|selector-\d+\b)' .argent/e2e/<name>.yaml
rg -n '(visible|hidden|exists) *: *["'"'"'A-Za-z0-9]' .argent/e2e/<name>.yaml
# Fixed waits and skipped navigation
rg -n '^\s*- wait:|open-url' .argent/e2e/<name>.yaml
```

The condition grep matches a condition key with a scalar after it (`visible: Save`) and not `visible:` opening a map. Recorder output is always block style, so both forms are one line below their `await:`/`assert:`. It covers `when:` guards too, which take the same loose fallback.

Resolve every hit and confirm:

- Every element action uses a stable selector unless the fallback gate cleared and documented it.
- **No `role:` stands as the only key under a `tap:`/`long-press:`.** It comes from the recorder's last-resort fallback or a hand edit. Replace it, or clear it through the fallback gate. A `role:` beside another field or a scope (`within`, `after`, `next`) is deliberate and needs no defence.
- Every element-seeking gesture became `scroll-to`.
- No device id or literal credential remains.
- Every selector-bearing condition uses an explicit selector map without positional or data-derived values.
- Every fixed wait has an echo and a following hard check. Prefer a condition or `idle`.
- No `open-url` replaces tested navigation.
- Every snapshot is intentional, deterministic, non-mutating, and ready for reviewed baseline creation.
- The standalone launch and real first-screen gate are present. Only Chromium permits an inserted launch.
- Every screen change has a destination-only identity check and an `idle` readiness check. The two are repaired differently: record a missing identity check live on the restored screen, but add a missing readiness gate in YAML, because `await: { idle: true }` has no recorder form.
- Every `hidden` check follows a `visible` check on the same stable selector and the removing action. A proven containing screen is not a substitute, because it is no evidence the selector itself ever resolved.

## Replay

Run `e2e-execute` on the complete YAML with the absolute project root. For a fragment, verify its prerequisite before setting `prerequisiteAcknowledged: true`.

Over `argent link` or `ARGENT_TOOLS_URL`, the client uploads the test and the files its steps need. `e2e-execute`'s `flow_path` parameter lists what travels and which steps a linked run rejects (`script:`, recording tools, directory, app or output-directory arguments such as `reinstall-app`'s, relative or non-`.png`/`.yaml` file arguments, file paths built from several arguments). Beyond that list:

- Keep every file a step needs (`run:` fragments, tests named by `tool: e2e-execute`, `.png`/`.yaml` arguments such as `screenshot-diff`'s `baselinePath`) as a real file under `project_root`, its `.argent/e2e/` or `.argent/flows/`, or beside the test file, not behind a symlink to another place. Otherwise the step reports `error` when it runs, after the earlier steps acted.
- A `tool: e2e-execute` step works over a link only with `name` and an absolute `project_root` without a `..` segment. Spell `name` in the letter case of its file.
- A `baseline not written` line in the report means that the client did not save that baseline: fix the reason in the line and run again.
- The tool-server rejects unsupported steps before the first step, listing each with the reason; a fragment or test that does not exist fails only when its step runs. Run a test that needs a rejected step with no link and no `ARGENT_TOOLS_URL`, on the computer that runs the tool-server.

Manual rescue invalidates the pass. An `errored` step was never evaluated: an `idle` wait whose tree source could not be read, a step that threw, an unresolvable `run:` target, or a `launch:` that did not start the app. Read the reason: most name the environment, but a failed `launch:` is a verdict about the app. Unconfirmed focus is not in this class at all: the replay focus poll has no failure return, so a `type:` step whose focus was never confirmed is scored a **pass**, and only the value check after typing catches it.

**A passing step that carries a `warning` is a finding, not noise.** `await: { idle: true }` raises [six different warnings](e2e-yaml.md#idle-readiness) and they do not share one meaning or one repair. No report separates intended motion from a load that never finished. Read which one it is, look at that screen, disclose what you found, and confirm the following step targets a stable element rather than stillness.

A [selector-less gesture](e2e-yaml.md#directives) warns in a different shape: it dispatched blind during a tree-source outage, so the green says only that the gesture was sent. Restore the source, usually by relaunching the app. Accept it only where the app serves no tree at all, such as the [injection-free iOS form](reliability-and-recovery.md#terminally-non-injectable-ios-apps).
