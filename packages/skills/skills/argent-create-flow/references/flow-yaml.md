# Flow YAML

Read this reference when polishing, composing, or manually reviewing a flow.

- [File shape and flow type](#file-shape-and-flow-type)
- [Selectors](#selectors)
- [Directives](#directives)
- [Verification conditions](#verification-conditions)
- [Prove a navigation](#prove-a-navigation-identity-then-readiness)
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

An e2e flow has a literal `launch:` as its first non-echo step. It cannot declare `executionPrerequisite`. Put the named start state in a leading echo.

A leading `run:` does not classify the outer flow as e2e, even when the child launches. This distinction controls Chromium boot. A fragment has no leading launch and can declare:

```yaml
executionPrerequisite: User is signed in and viewing Settings
steps: []
```

Flows never store a device id. The runner binds the device. `launch:` restarts the process but does not clear app, account, or backend data.

The one exception is a device _scope_ rather than a target: `stop-all-simulator-servers`' `devices` list **is** kept in the YAML, because without it the step means the machine-wide sweep and would tear down devices other agents are mid-session on. Replay rebinds a recorded scope only when you pass `device` explicitly — an auto-detected device would retarget the teardown at a device the flow never named. So the recorded ids are what run when you replay without `device`; on another host they reap nothing and come back in `unmatched`, so re-record the cleanup flow there or pass `device`. A step that recorded no scope is still narrowed onto whatever device the run resolved, since binding can only make the sweep smaller.

## Selectors

Use values that meet the [stable-selector definition](../SKILL.md#stable-selectors). Always write explicit maps:

```yaml
{ id: save-button }
{ text: Save }
{ role: button }
{ id: settings-row, text: Notifications }
```

All provided fields must match. `id` is exact and case-insensitive. `text` and `role` are case-insensitive substrings. An unqualified Android id also matches its qualified resource id. `identifier` is accepted as an alias, but `id` is canonical. Never author a bare string. It is loose shorthand that tries id before text.

Use single quotes for anchored, case-sensitive regexes:

```yaml
{ text: { matches: '^Order #\d+$' } }
```

### The runner tree is not the discovery tree

Flow selectors and live discovery use different screen projections:

| Platform | Runner tree                                               | `describe` / `await-ui-element` | Important difference                                     |
| -------- | --------------------------------------------------------- | ------------------------------- | -------------------------------------------------------- |
| iOS      | native UIView hierarchy                                   | accessibility tree              | Each contains elements and roles missing from the other  |
| Android  | full accessibility hierarchy                              | trimmed interactables           | Discovery can omit testID-only containers or merge nodes |
| Chromium | filtered DOM nodes with id, label, value, click, or focus | full DOM walk                   | The runner tree is a strict subset                       |
| Vega     | toolkit page source                                       | same source                     | Same elements, different shape                           |

On iOS and Android, an id absent from `describe` can still resolve in a flow. Prefer the stable id and verify it in a scratch fragment. On Chromium, an element absent from `describe` cannot resolve. Add a test id instead.

A live wait can pass against its tree while the converted directive cannot resolve. Replay after conversion. Treat failure there as a polish blocker, not a recording failure.

When several nodes match, exact text or id beats substring, then the smallest frame wins. Use a stricter selector when ranking can still choose the wrong element.

### Relational scopes

Flow selectors support frame-based `within`, `after`, and `next` in every selector slot. Live `await-ui-element` does not support them.

```yaml
- tap: { text: Delete, within: { id: profile-card } } # inside a container
- assert: { visible: { role: Button, after: { text: Danger zone } } } # any follower
- tap: { role: Switch, next: { text: Wi-Fi } } # nearest matching follower
```

`within` means visual frame containment, not source-tree ancestry. Overflowing children and anchored popovers can fall outside it. `after` and `next` use top-to-bottom, left-to-right reading order. A target cannot satisfy its own `within`, `after`, or `next` anchor. The synthetic root never counts.

`next` finds the nearest matching follower and skips non-matches. It can therefore reach the next row when the intended row lacks a control. Prefer a stable row container with `within`, or assert the row-local control first.

Scopes can combine and nest, with at most six scope keys. Use strict selectors for anchors. Scope through a trusted container when a missing control must fail instead of reaching another row.

## Directives

Directives stop the flow on failure and skip later steps. `flow-execute` documents their shapes. The available directives are `launch`, `tap`, `long-press`, `type`, `scroll-to`, `pinch`, `rotate`, `await`, `assert`, `wait`, `snapshot`, `run`, `when`, `echo`, and `tool`.

Use the launch map for cross-platform flows. `native` covers iOS, Android, and Vega. `chromium` accepts a relative or absolute app path. A bare launch applies everywhere and becomes an app path on Chromium.

```yaml
- launch: { native: com.acme.app, chromium: ../../app }
```

An Android app that needs a non-launcher activity has no `launch:` form. Record `restart-app` with `activity` and keep the flow as a fragment.

In a `scroll-to` map, put the selector under `target:`. The map supports `up`, `down`, `left`, and `right` directions. The default is `down`. If the target is already visible, the step is a safe no-op. `tap`, `type`, and `long-press` do not auto-scroll. Add `scroll-to` when the target can be off-screen. Use `within` for a nested scroller.

`type` presses Enter unless `submit: false`. A polished focus tap plus keyboard call usually needs `submit: false`. Store external values as `{{secret:NAME}}`. The runner uses the first source that defines the name: environment `ARGENT_SECRET_NAME`; project `.argent/secrets.env`; project `.env.local`, then `.env` (only `ARGENT_SECRET_` keys); then `~/.argent/secrets.env`. It redacts every resolved value, so do not use a placeholder for content a report must show.

## Verification conditions

```yaml
- await: { visible: { id: settings-screen } }
- await: { hidden: { id: loading-spinner }, timeout: 15000 }
- assert: { exists: { id: notifications-toggle } }
- assert: { text: { in: { id: preference-status }, equals: Enabled } }
- assert: { text: { in: { id: result-count }, matches: '^\d+ results$' } }
```

`text.in` locates one element. It compares that element's rendered and descendant text with exactly one comparator:

- `contains`: case-insensitive substring.
- `equals`: case-insensitive full match.
- `matches`: case-sensitive JavaScript regex.

Use `equals` or an anchored regex when boundaries matter. For example, `contains: "Taps: 3"` also matches `Taps: 30`.

Use `await` for an outcome that can take time. Its default is 7500 ms. Add a larger timeout only after the default expires. Use `assert` for settled state. It has a fixed 1000 ms grace and rejects `timeout`.

A negative condition proves only that the current tree has no visible match. It also passes before the element appears, for a typo, or on the wrong screen. First prove the containing screen and the same stable selector as `visible`. Then perform the removing action and check `hidden`. Prefer an additional positive replacement or empty state.

## Prove a navigation: identity, then readiness

Every screen change needs both checks:

```yaml
- await: { visible: { id: profile-screen } } # identity
- await: { idle: true } # readiness
```

The identity selector must exist only on the destination. A dropped tap can leave the source screen idle. A destination element can enter the tree before its animation finishes. Therefore neither check replaces the other.

### `idle` readiness

`idle` waits until the screen has content and stops changing in both the UI tree and pixels.

```yaml
- await: { idle: true, stableFor: 400, timeout: 9000 }
```

`stableFor` (default 250) is how long stillness must hold, and must be shorter than `timeout` (default 7500). The wait must also fit the hold plus the 600ms a settle costs — three reads spanning two 200ms polls, plus the 200ms of budget the closing round needs to be allowed to start — or parse rejects the step. Stillness is measured across intervals, so `stableFor: 0` means the first two agreeing intervals, not the first read. `idle` has no assert form and no `when:` form.

It **never fails a run.** Every outcome short of a clean settle passes with a warning, because readiness is not an acceptance criterion. Read that warning rather than stepping over it. It distinguishes a screen that never held still (video, shimmer, carousels, or live text stay healthy while moving, and a load that never finished looks identical), a small part still changing through the hold (a spinner, caret, or progress dot — tolerated, so the settle completed anyway), an empty tree (a canvas or video surface, or a screen that never arrived), a settle on the UI tree alone (no screenshot pair could be read, so presentation-layer animation was never waited out), and too few reads to judge either way.

Only a tree source that cannot be read stops the run, as an errored step — one still failing when the wait ends, one that wedges after answering, or one that never answers (raise `timeout` before suspecting the app). The run is then not ok and every later step is skipped. A single failed read is not that: the hold restarts from the next good read.

`idle` proves readiness only and never identifies the screen, so it cannot serve as acceptance evidence or replace the identity gate. Gate the next action on a stable element. Add `idle` during polish after each screen change, not after every step.

## Optional divergences

Use `when:` only for optional setup or an interstitial that reconverges:

```yaml
- when: { visible: { text: Got it } }
  steps:
    - tap: { text: Got it }
```

The guard accepts one `exists`, `visible`, `hidden`, or `text` condition, or `{ platform: ios|android|chromium|vega }`. UI guards use the short assert grace and reject `timeout`. There is no `else` or per-step `optional`. Put separate behavioral paths in separate flows. Never place a required acceptance check inside `when:`.

## Composition and platform limits

A `run:` target is a YAML path resolved against the directory of the flow file containing the step, so `../shared/login.yaml` reaches a sibling directory rather than the project root. The `.yaml` suffix is optional: `run: login` and `run: login.yaml` both name `login.yaml` beside the flow.

- iOS and Android can run fragments or e2e flows inline. A nested e2e launch restarts its app.
- Chromium boots one Electron app for the top-level run. Do not nest another Chromium e2e launch. Make that flow top-level or a fragment. Chromium rejects `pinch`. Use app zoom controls.
- Vega uses `tool: tv-remote` and raw `tool: keyboard`. Touch directives are unsupported. Gate focus and navigation results with `await`.

## Snapshots and standalone runs

`argent flow run <name> [--device <id>] [--platform ios|android|chromium|vega] [--update-baselines] [--output <dir>] [--json]` runs without an LLM and exits non-zero on failure.

A screenshot is human evidence. A `snapshot:` is executable visual verification. A missing baseline or excessive mismatch fails. A `cropOn` size change also fails. Use snapshots for color, layout, size, spacing, typography, clipping, overflow, images, icons, or stable component appearance. Use full screen for global changes and `cropOn` for one component.

Do not use a snapshot as the only proof of navigation, persistence, data, accessibility state, logs, or network behavior. Avoid unstable timestamps, live data, ads, animation, and device drift. First establish deterministic state, identity, and readiness.

Baselines live under `.argent/flows/__baselines__/<flow>/` and are keyed by platform and full-capture geometry; `cropOn` also contributes its selector. Seed from a known-good state with `--update-baselines`. Inspect every baseline and require user review. Do not commit it yourself. Baseline creation or update is not a test pass. Never update a baseline only to make a diff pass. The default `maxMismatch` is 0.5 percent.

Pin `--platform` and `--device` for iOS, Android, or Vega. For Chromium, persist window size in `launch.chromium.args`, pass `--platform chromium`, and omit `--device`. The runner pins mobile status bars during visual runs. `--output <dir>` writes failed baseline, current, and diff images under `<dir>/<flow>/` for CI artifact upload.

## YAML safety

Quote strings containing `#`, `:`, or quotes. Quote numbers and `true` or `false` in text slots. Use single quotes for regexes with backslashes. Parsing rejects invalid directives, selectors, regexes, `else`, unsupported options, and e2e flows that also declare `executionPrerequisite`.
