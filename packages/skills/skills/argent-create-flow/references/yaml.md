# Flow YAML

Read this file when you convert, write, or examine a flow.

## File shape

```yaml
steps:
  - launch: com.example.app
  - await: { visible: { id: home-screen } }
  - await: { idle: true }
```

A failed step stops the flow, and the runner does not do the subsequent steps. An **e2e** flow has `launch:` as its first step after an `echo`. A **fragment** starts with a different step and declares `executionPrerequisite`, one sentence that names the start state. The file does not contain a device id. `launch:` restarts the process but keeps the app, account, and backend data.

## Selectors

Write a selector as a map. `id` is exact and case-insensitive (`identifier` is an alias). `text` and `role` are case-insensitive substrings. `text` also takes `{ matches: '<regex>' }` in single quotes. All fields must match.

```yaml
{ id: save-button }
{ text: Save }
{ id: settings-row, text: Notifications }
{ text: { matches: '^Order #\d+$' } }
```

Do not write a bare string such as `tap: Save`. It tries `id` first and then `text`, which is a different check. When more than one element matches, an action takes the most specific visible match: exact text or id, then the smallest frame, then reading order. A condition holds when one or more matches qualify, `hidden` holds when no match qualifies, and `text` reads the first visible match. Thus a tap can hit a leaf while `text.in` reads its container. Use an `id` or a relational scope when an action and a check must agree.

### Relational scopes

```yaml
- tap: { text: Delete, within: { id: profile-card } } # inside a container
- assert: { visible: { role: Button, after: { text: Danger zone } } } # any follower
- tap: { role: Switch, next: { text: Wi-Fi } } # nearest matching follower
```

`within` is visual containment, not the source tree. `after` and `next` use reading order (top to bottom, left to right). `next` skips neighbors that do not match, so it can get to the next row when the intended row has no control. When a missing control must fail, use `within` on a stable row container. A child that overflows its container, or a popover anchored to it, is outside `within`. Use a strict selector (an id or exact text) for each anchor. Scopes nest, with a maximum of six scope keys. Live `await-ui-element` does not support scopes. On `scroll-to`, the top-level `within` names the scroller, not a match scope. To limit which element matches, put `within` inside `target`.

## Directives

| Directive    | Shape                                                              | Notes                                                     |
| ------------ | ------------------------------------------------------------------ | --------------------------------------------------------- |
| `launch`     | `<app id>` or a [launch map](#launch-map)                          | Restarts the app and waits until the app is available     |
| `tap`        | `<selector>`, `{ on, times }`, or `{ x, y }`                       | `times: 2` double-taps. `x` and `y` are normalized        |
| `long-press` | `<selector>` or `{ on, duration }`                                 | `duration` in ms                                          |
| `type`       | `{ into, text, submit }`                                           | Presses Enter unless `submit: false`                      |
| `scroll-to`  | `{ target, direction, within }`                                    | `direction` is `down` (default), `up`, `left`, or `right` |
| `swipe`      | `<direction>` or `{ from, direction, to, by, momentum, duration }` | The travel of the finger. See [Swipe](#swipe)             |
| `pinch`      | `{ on, scale }`                                                    | `scale` > 1 zooms in. Screen center without `on`          |
| `rotate`     | `{ on, by }`                                                       | Degrees, clockwise positive. Not the device orientation   |
| `await`      | `{ <condition>, timeout }` or `{ idle: true, stableFor, timeout }` | Default `timeout` 7500 ms                                 |
| `assert`     | `{ <condition> }`                                                  | Fixed 1000 ms grace. Rejects `timeout`                    |
| `wait`       | `<ms>`                                                             | Give it an echo and a hard check after it                 |
| `snapshot`   | `<name>` or `{ name, maxMismatch, cropOn }`                        | See [Snapshots](#snapshots)                               |
| `run`        | `<path>`                                                           | See [Composition](#composition)                           |
| `when`       | `{ <condition> }` or `{ platform }`, with `steps:`                 | See [Optional steps](#optional-steps)                     |
| `echo`       | `<message>`                                                        | Printed in the report                                     |
| `tool`       | `<tool name>`, with `args:` and optional `delayMs:`                | One of the Argent tools                                   |

A `type` step can contain `{{secret:NAME}}`. The runner uses the first source that has the name: the environment variable `ARGENT_SECRET_NAME`, the project `.argent/secrets.env` as `NAME`, `.env.local` or `.env` as `ARGENT_SECRET_NAME`, then `~/.argent/secrets.env` as `NAME`. The report redacts the value, so do not use a secret for text that the report must show.

### Swipe

`swipe` is one flick where the gesture is the action: dismiss a card, page a carousel, pull to refresh. Do not use `swipe` to scroll. To make an element visible, use `scroll-to`. `direction` is the travel of the finger, opposite to the content direction of `scroll-to`: `swipe: left` shows the content on the right. Give one travel: `direction`, `by: { x, y }` (signed screen fractions), or `to` (a selector or a point). `from` anchors the start on a selector or a point. The travel must be at least 0.03. Near an edge of the screen, use `direction`. It becomes shorter to fit, but a `by` with a `from` fails. For a system edge gesture, write a raw `tool: gesture-swipe` step. `momentum: false` stops where the finger stops, with a `duration` of at least 150 ms (default 300). On Chromium, do not anchor `from` on an image, a link, or a `draggable` node.

### Launch map

```yaml
- launch: { native: com.acme.app, chromium: ../../app }
- launch: { ios: com.acme.app, android: com.acme.app.android, chromium: ../../app }
```

`native` is one id for iOS and Android. A per-platform key replaces it. `chromium` takes an app path or `{ path, args }`. A launch with no id for the platform of the run is an error.

## Conditions

```yaml
- await: { visible: { id: settings-screen } }
- await: { hidden: { id: loading-spinner }, timeout: 15000 }
- assert: { exists: { id: notifications-toggle } }
- assert: { text: { in: { id: preference-status }, equals: Enabled } }
- assert: { text: { in: { id: result-count }, matches: '^\d+ results$' } }
```

`exists` holds when an element matches, `visible` when a visible element matches, and `hidden` when no visible element matches. `text` compares the text of the element in `in` with one comparator: `contains`, `equals`, or `matches` (case-sensitive regex). `contains: "Taps: 3"` also matches `Taps: 30`, so when the boundaries are important, use `equals` or an anchored regex.

Use `await` for a result that comes after an interval. Increase its timeout only after the default expires. Use `assert` for a settled state. A `hidden` check also passes before the element shows, for a typo, and on the incorrect screen. Record it in three steps ([Record: Absence](record.md#absence)).

### Navigation checks

```yaml
- await: { visible: { id: profile-screen } } # identity
- await: { idle: true } # readiness
```

The identity selector must be only on the destination screen. `idle` waits until the UI tree has elements and the screen does not move in the tree or in the pixels. The two checks do not replace each other.

```yaml
- await: { idle: true, stableFor: 400, timeout: 9000 }
```

`stableFor` (default 250 ms) is how long the screen must not move. `timeout` (default 7500 ms) is the maximum time of the full wait. The smallest `timeout` is 600 ms. When `stableFor` is more than 400 ms, the smallest `timeout` is `stableFor` + 200 ms.

`idle` does not fail a run. When the screen does not settle, the step passes with a warning. Read [Idle warnings](warnings.md#idle-warnings).

`idle` has no `assert` form and no `when` form. Add it after each screen change, not after each step.

## Optional steps

```yaml
- when: { visible: { text: Got it } }
  steps:
    - tap: { text: Got it }
```

The guard is one `exists`, `visible`, `hidden`, or `text` condition, or `{ platform: ios | android | chromium }`. It uses the assert grace and rejects `timeout`. There is no `else`. Put separate behavior paths in separate flows. Use `when:` only for optional setup that goes back to the necessary path. Do not put a necessary check in `when:`.

## Composition

`run: ../shared/login.yaml` resolves against the directory of the flow file. The `.yaml` suffix is optional. A nested fragment or e2e flow runs inline, and a nested launch restarts the app. If the `run:` chain of a fragment gets to a launch, the fragment cannot declare `executionPrerequisite`.

## Snapshots

```yaml
- snapshot: checkout-summary
- snapshot: { name: price-card, cropOn: { id: price-card }, maxMismatch: 0.2 }
```

A snapshot compares the screen, or the frame of `cropOn`, with a baseline in `.argent/flows/__baselines__/<flow>/`. A missing baseline, a mismatch above `maxMismatch` percent (default 0.5), or a `cropOn` dimension change fails the step. Write baselines from a known-good state with `--update-baselines` (`updateBaselines: true` in `flow-execute`). Examine each baseline. Let the user examine and commit it. Do not commit it yourself. A missing baseline fails the step, so CI needs the committed baseline. A baseline update is not a test pass. Do not update a baseline only to make a diff pass.

Use a snapshot for layout, color, spacing, typography, clipping, and icons. Do not use it as the only proof of navigation, data, or network behavior. Keep timestamps, live data, ads, and animation out of the captured region.

## YAML safety

Quote a string that contains `: ` or ` #`, or that starts with a quote or a special character. An id such as `com.acme:id/save` is correct without quotes. Quote a number, `true`, or `false` in a text slot. Use single quotes for a regex with backslashes.
