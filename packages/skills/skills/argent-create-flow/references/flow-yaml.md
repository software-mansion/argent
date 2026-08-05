# Flow YAML

Read this reference when polishing, manually reviewing, or composing a flow.

- [File shape and flow type](#file-shape-and-flow-type)
- [Selectors](#selectors)
- [Directives](#directives)
- [Verification conditions](#verification-conditions)
- [Prove a navigation: identity, then readiness](#prove-a-navigation-identity-then-readiness)
- [Optional divergences](#optional-divergences)
- [Composition and platform limits](#composition-and-platform-limits)
- [Snapshots and standalone runs](#snapshots-and-standalone-runs)
- [YAML safety](#yaml-safety)

## File shape and flow type

```yaml
steps:
  - launch: com.example.app
  - await: { visible: { id: home-screen } }
  - await: { idle: true }
```

An e2e flow's first non-echo step is `launch:`, and it must not declare `executionPrerequisite` — the combination is a parse error. Put the named start state in a leading `echo:` instead. A leading `run:` does **not** make a flow e2e even when the composed flow launches: that launch does run inline, but the runner classifies only a literal leading `launch:` as e2e, and on Chromium that classification is what boots the app. A fragment has no leading launch and may declare:

```yaml
executionPrerequisite: User is signed in and viewing Settings
steps: []
```

Flows never store a device id. The runner binds the selected/booted device. `launch:` restarts the app process; it does **not** clear persisted app, account, or backend data.

## Selectors

Use selector values that meet the [stable-selector definition](../SKILL.md#stable-selectors). Write explicit selector maps:

```yaml
{ id: save-button }       # exact testID/accessibilityIdentifier/resource-id
{ text: Save }            # case-insensitive text/label substring
{ role: button }          # case-insensitive role substring
{ id: settings-row, text: Notifications } # fields all must match
```

`id` is exact and case-insensitive; an unqualified Android id such as `save-button` also matches `com.example:id/save-button`. `identifier` parses as an alias for `id`, but `id` is canonical and is what the recorder writes. A bare string is loose shorthand that tries id first and then text. Never write a bare string in a flow you author; always write the explicit map.

For dynamic native text, use an anchored, case-sensitive regex and single quotes:

```yaml
{ text: { matches: '^Order #\d+$' } }
```

### The runner tree is not the discovery tree

Flow selectors resolve against the runner's tree. The agent-facing `describe` tool and the live `await-ui-element` tool read a **different** projection of the same screen, and how the two differ is platform-specific — it decides what a missing element means:

| Platform | Runner tree                                                                                | `describe` / `await-ui-element`         | How they differ                                                                                                |
| -------- | ------------------------------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| iOS      | native UIView hierarchy                                                                    | accessibility tree                      | Each holds elements the other lacks; the role vocabularies are disjoint (`AXButton` exists only in `describe`) |
| Android  | full accessibility hierarchy, including not-important views                                | the same dump, trimmed to interactables | Each holds elements the other lacks; the trim drops testID-only containers and merges nodes                    |
| Chromium | the same DOM walk, keeping only nodes with an id, label, value, clickable or focused state | the whole DOM walk                      | The runner tree is a strict **subset**                                                                         |
| Vega     | toolkit page source                                                                        | the same source                         | Same elements, re-shaped                                                                                       |

Two consequences, both load-bearing:

- **On iOS and Android**, a missing id in `describe` is not proof that the flow selector cannot resolve: prefer the id and verify it in a scratch fragment. **On Chromium the reverse holds** — what `describe` does not show, no selector can reach, and an element it does show carrying none of those five attributes is invisible to the runner. Give that element a testid instead of hunting for another selector.
- A live `await-ui-element` check can pass against the tool's tree and mean nothing to the runner. The recorded `tool:` step still replays (that tool reads the tree it passed against); it is the `await:`/`assert:` directive polish converts it into that may not resolve. Replay the flow after polish and treat an unresolved converted wait as a polish-time blocker, not a recording failure.

When several visible nodes match, an exact text/identifier match beats a substring hit, then the smallest frame wins. Use a stricter map when that ranking could still select the wrong repeated element.

### Relational scopes

Flow YAML selectors also accept geometric, CSS-like relations. They work in every flow selector slot (`tap`, `type.into`, `await`, `assert`, `scroll-to`, `pinch.on`, `rotate.on`, `snapshot.cropOn`, and nested scopes), but not in the live `await-ui-element` tool.

```yaml
- tap: { text: Delete, within: { id: profile-card } } # inside a container
- assert: { visible: { role: Button, after: { text: Danger zone } } } # any follower
- tap: { role: Switch, next: { text: Wi-Fi } } # nearest matching follower
```

The relations are frame-based because platform flow trees are flattened. `within` means visual containment, so a child whose frame spills outside its parent's — an overflowing row, a popover anchored to a card — does not match it, however clearly it is that parent's child in the code. `after` and `next` use top-to-bottom/left-to-right reading order. Every anchor must be distinct; the synthetic screen root never counts.

`next` means the nearest **matching** follower, so it deliberately skips wrappers, spacers, and other non-matches. This differs from literal CSS `+`: if a Wi-Fi row has no switch, `{ role: Switch, next: { text: Wi-Fi } }` may find the next row's switch. Prefer `{ role: Switch, within: { id: wifi-row } }`, or assert that row-local control before acting, whenever the control may be absent.

Scopes may combine and nest, with at most six scope keys per selector. Scope the target by a trusted container when a missing row control must fail instead of reaching another row. Use a strict map for an anchor you care about; a bare string keeps the loose identifier-first fallback and can bind to an unrelated id.

## Directives

Every directive hard-stops the flow on failure; later steps are skipped. The set is `launch`, `tap`, `long-press`, `type`, `scroll-to`, `pinch`, `rotate`, `await`, `assert`, `wait`, `snapshot`, `run`, `when`, `echo`, and `tool`; `flow-execute`'s own tool description spells out each one's shape and options. What follows is only what that description does not say.

A bare `launch: com.acme.app` applies to every platform — and on Chromium it is read as the app **path**, so any flow that must run cross-platform needs the map form. `native:` covers iOS, Android, and Vega with one id: `- launch: { native: com.acme.app, chromium: ../../app }`. An Android app that must start on a non-launcher activity has no `launch:` form at all; record `restart-app` with its `activity` and accept that the flow is a fragment.

A `scroll-to` map is always the options form — the target goes under `target:`. Only the bare-string form (`scroll-to: Logout`) omits it, and that spelling is a loose selector.

`tap`, `type`, and `long-press` do not auto-scroll. Add `scroll-to` first whenever the target may be off-screen. `scroll-to` defaults to `down`, is a no-op if already visible, and needs `within` for a nested scroller.

`type` presses Enter unless `submit: false`. A polished focus-tap + raw keyboard pair normally needs `submit: false`, because the recording did not submit. Store secrets as `{{secret:APP_PASSWORD}}`; the runner resolves them from `ARGENT_SECRET_APP_PASSWORD` or a secrets file (`.argent/secrets.env`, `~/.argent/secrets.env`, `.env`), so one flow runs unchanged in CI and locally. Use it for any external value, not only sensitive ones — but every resolved value is redacted from output, so never use it for something a report must show.

## Verification conditions

The condition name is the key and its value is the selector:

```yaml
- await: { visible: { id: settings-screen } }
- await: { hidden: { id: loading-spinner }, timeout: 15000 }
- assert: { exists: { id: notifications-toggle } }
- assert: { text: { in: { id: preference-status }, equals: Enabled } }
- assert: { text: { in: { id: result-count }, matches: '^\d+ results$' } }
```

`text.in` locates one selector and compares its rendered/descendant text with exactly one of `contains` (case-insensitive substring), `equals` (case-insensitive exact match), or `matches` (case-sensitive JS regex). Substring boundaries are not implied: `contains: "Taps: 3"` is also satisfied by `Taps: 30`, so use `equals` or an anchored `matches` pattern when the complete value matters. Use a regex selector under `visible` when only the shape of free-standing text matters.

Use `await` for an outcome that may take time and `assert` for settled state. The default `await` wait is 7500 ms; `assert`'s fixed grace is 1000 ms. Add an `await.timeout` only after the 7500 ms default demonstrably expires, and only above it — a value below 7500 shortens the wait. `assert` rejects `timeout`; a timed check is an `await`.

A negative condition such as `hidden` only says that no visible match exists in the current tree. It is true before the element ever appears, true if the selector is misspelled, and true on the wrong screen. Establish it positively first: prove the containing screen, and prove the same selector `visible` at some earlier point in the flow. A `hidden` whose selector never matched anywhere in the flow passes on every replay no matter what the app does, so it is not a check at all. When possible also verify a positive replacement or empty state.

## Prove a navigation: identity, then readiness

A navigation needs two checks, and no single one covers both:

```yaml
- await: { visible: { id: profile-screen } } # identity: WHICH screen
- await: { idle: true } # readiness: it stopped moving
```

**They are independent.** A dropped tap leaves the source screen perfectly idle, so readiness never proves identity. A destination element enters the tree while the transition is still animating over it, so identity never proves readiness.

Identity is an element that exists **only** on the destination ([which ones qualify](reliability-and-recovery.md#strong-transition-gates)).

### `idle` — readiness

The one condition that carries no selector, because stillness is a property of the whole screen. It returns the moment the screen has content and stops moving in **both** the UI tree and the rendered pixels, so the next tap resolves its target against a screen that has stopped rather than one still sliding under it.

```yaml
- await: { idle: true, minStableMs: 400, timeout: 9000 }
```

The pixel half is why it exists: an iOS push or modal dismissal commits its hierarchy up front and then animates a layer for a few hundred milliseconds, and a cross-fade or scrim moves no node at all. A tree-only wait returns mid-transition.

`minStableMs` (default 250) is how long stillness must hold; it must be shorter than `timeout` (default 7500) or the gate could never pass, and parse rejects it. Stillness is measured across intervals, so a settle takes at least three reads: `minStableMs: 0` means "the first two agreeing intervals", not "the first read".

It has no `assert` form — waiting is the whole point. Prefer it over `wait:` for any transition with no element to gate on.

**It never fails a run.** A screen that never settles spends the timeout, then passes with a `warning` on the step — readiness is not an acceptance criterion, and healthy screens often never stop (a video, a shimmer, a carousel, live-updating text, which on Android moves the tree as well as the pixels). Treat that warning as a finding: go and look, because a load that never finished looks exactly the same from the report. Gate the next action on a stable element, never on stillness.

Two more limits. It says nothing about **which** screen settled, so it never replaces the identity gate. And where no screenshot could be read it passes on the tree alone with a different `warning` — the hierarchy held still, but presentation-layer motion above it was never waited out. Only an unreadable or permanently empty tree stops a run, as an `errored` step.

Add one during polish after each screen change, not after every step: it is a directive with no live tool behind it, and each costs roughly 0.5-1.5 s warm — more on the first capture of a run.

## Optional divergences

Use `when:` only for a one-sided optional path such as a coach mark:

```yaml
- when: { visible: { text: Got it } }
  steps:
    - tap: { text: Got it }
```

The guard may be one `exists`/`visible`/`hidden`/`text` condition or `{ platform: ios|android|chromium|vega }`. It uses the short assert grace. There is no `else` and no per-step `optional`; separate behavioral paths belong in separate flows. A skipped optional block is not a failure, but a required acceptance check must never live behind a condition that may skip it.

## Composition and platform limits

- iOS/Android e2e flows may run fragments or other e2e flows inline; a nested e2e launch restarts its app.
- Chromium boots one Electron app for the top-level run. Do not nest a Chromium e2e flow with its own launch; make it top-level or turn the nested flow into a fragment. `pinch` is rejected there — drive the app's own zoom controls instead.
- Vega is remote-driven. Touch directives (`tap`, `long-press`, `type`, `scroll-to`, `pinch`) are unsupported; record `tool: tv-remote` and raw `tool: keyboard`, then gate every focus/navigation result with `await`.

## Snapshots and standalone runs

`argent flow run <name> [--device <id>] [--platform ios|android|chromium|vega] [--update-baselines] [--output <dir>] [--json]` runs without an LLM and exits non-zero on failure.

A raw `screenshot` captures evidence but never compares or fails on visual drift. Keep it for live inspection, diagnosis, or a human-reviewed before/after result. A `snapshot:` directive is executable verification: it compares the current pixels with a stored baseline and hard-fails on a missing baseline, excessive mismatch, or (for `cropOn`) region-size drift.

Use a snapshot when pixels are part of the requirement and structural selectors cannot prove the rendering:

- light/dark theme or other global color-mode changes;
- layout, position, size, spacing, typography, clipping, overflow, image, or icon rendering;
- a stable component whose appearance matters beyond its accessibility state.

Pair visual and structural evidence when the requirement is mixed. Use a full-screen snapshot for a global theme/layout and `cropOn` for one stable component to reduce unrelated noise.

Do not use a snapshot as the only proof of navigation, persistence, data correctness, accessibility state, logs, or network behavior. Avoid it when timestamps, random/live data, ads, uncontrolled animation, or device drift make the pixels unstable. First make the screen deterministic and gate its identity/readiness with `await:` or `assert:`.

Snapshot baselines live under `.argent/flows/__baselines__/<flow>/`, keyed by platform and full-capture resolution; `cropOn` also keys by selector. A `snapshot:` step fails when no baseline exists for the run's device class. Seed from a known-good state with `--update-baselines`, inspect every generated baseline against the requirement, tell the user it requires review, and do not commit it yourself. Baseline creation or update is not a test pass. Never update a baseline merely to make a failing diff green. The default `maxMismatch` is `0.5` percent.

For iOS, Android, or Vega, record the seeding run's `--platform` and `--device` values and pass the same flags in CI so the device class stays pinned. For Chromium, persist the window-size argument in `launch.chromium.args`, run with `--platform chromium`, and omit `--device` so the runner boots the declared target with those arguments; pinning an already-running Chromium device bypasses the launch. The runner pins the iOS/Android status bar during a run to keep clock, battery, and signal changes out of full-screen visual diffs.

`--output <dir>` writes failed snapshot baseline/current/diff images under `<dir>/<flow>/`, a stable directory for CI artifact upload.

## YAML safety

Quote strings containing `#`, `:`, or quotes. A bare `true`/`false` or a number in a text slot is rejected at parse, so quote those too; `yes`/`no`/`on`/`off` parse as plain strings. Use single quotes for regex containing backslashes.

Parse failures include invalid directives, selector shapes, regexes, `else`, unsupported options, and an e2e flow that combines a leading `launch:` with `executionPrerequisite`.
