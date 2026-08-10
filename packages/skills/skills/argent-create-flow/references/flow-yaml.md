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

An e2e flow's first non-echo step is `launch:`. It must not declare `executionPrerequisite` — the combination is a parse error. Put the named start state in a leading `echo:` instead.

A leading `run:` does **not** make a flow e2e by that classification, but the runner still follows the chain to the launch it reaches. On Chromium that launch boots the app before step 1, exactly as a literal leading `launch:` does. On every platform, a flow whose leading `run:` chain reaches a launch is refused an `executionPrerequisite` too — parse accepts the file and the run then rejects it. The one way out is a run pinned to a Chromium instance you brought to the required state yourself (`--device chromium-cdp-<port>`), where the leading launch only attaches.

A fragment reaches no leading launch, by its own step or through a `run:` chain, and may declare:

```yaml
executionPrerequisite: User is signed in and viewing Settings
steps: []
```

Flows never store a device id. The runner binds the selected/booted device. `launch:` restarts the app process; it does **not** clear persisted app, account, or backend data.

The one exception is a device _scope_ rather than a target: `stop-all-simulator-servers`' `devices` list **is** kept in the YAML, because without it the step means the machine-wide sweep and would tear down devices other agents are mid-session on. Replay rebinds a recorded scope only when you pass `device` explicitly — an auto-detected device would retarget the teardown at a device the flow never named. So the recorded ids are what run when you replay without `device`; on another host they reap nothing and come back in `unmatched`, so re-record the cleanup flow there or pass `device`. A step that recorded no scope is still narrowed onto whatever device the run resolved, since binding can only make the sweep smaller.

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

| Platform | Runner tree                                                                                | `describe` / `await-ui-element`         | How they differ                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iOS      | native UIView hierarchy                                                                    | accessibility tree                      | Each holds elements the other lacks; both name roles `AX…`, but the runner derives them from the UIView class name and `describe` from accessibility traits, so one element can carry a different role in each |
| Android  | full accessibility hierarchy, including not-important views                                | the same dump, trimmed to interactables | Each holds elements the other lacks; the trim drops testID-only containers and merges nodes                                                                                                                    |
| Chromium | the same DOM walk, keeping only nodes with an id, label, value, clickable or focused state | the whole DOM walk                      | The runner tree is a strict **subset**                                                                                                                                                                         |
| Vega     | toolkit page source                                                                        | the same source                         | Same elements, re-shaped                                                                                                                                                                                       |

Two consequences, both load-bearing:

- **On iOS and Android**, a missing id in `describe` is not proof that the flow selector cannot resolve: prefer the id and verify it in a scratch fragment. **On Chromium the reverse holds** — what `describe` does not show, no selector can reach, and an element it does show carrying none of those five attributes is invisible to the runner. Give that element a testid instead of hunting for another selector.
- A live `await-ui-element` check can pass against the tool's tree and mean nothing to the runner. The recorded `tool:` step still replays (that tool reads the tree it passed against); it is the `await:`/`assert:` directive polish converts it into that may not resolve. Replay the flow after polish and treat an unresolved converted wait as a polish-time blocker, not a recording failure.
- **On iOS, never copy a `role` from `describe` into a flow selector.** A React Native `Pressable` is class `RCTView`, so the runner reads it `AXGroup` while its `button` trait makes it `AXButton` to `describe`; a `{ role: Button }` selector then matches nothing at replay. Confirm the role against the runner's own tree — the recorder derives its selectors from it — or select on `id`/`text` instead.

When several nodes match, what the runner does with them depends on the directive:

- **Action directives** (`tap`, `long-press`, `type`, `scroll-to`, `pinch`, `rotate`) take the most specific visible match. An exact text/identifier match beats a substring hit — a regex consuming the element's whole text counts as exact — then the smallest frame wins, then reading order.
- **Conditions** (`await`, `assert`) do not rank. `exists` and `visible` hold when any match qualifies and `hidden` only when none does, so no single element is elected. `text` reads the **first visible match in reading order** (topmost, then leftmost).

An action and a check therefore name different elements wherever a container aggregates a child's text — the everyday iOS `accessible` wrapper. `tap` hits the exact leaf; `text.in` reads the container above it, so `equals` fails against text that is correct on screen. Give the element an `id` or a [relational scope](#relational-scopes) whenever an action and a check must agree on it, and use a stricter map when the ranking could still elect the wrong repeated element.

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

A bare `launch: com.acme.app` applies to every platform — and on Chromium it is read as the app **path**, so any flow that must run cross-platform needs the map form.

The map takes `native:`, `ios:`, `android:`, `vega:`, and `chromium:`. `native:` is one id shared by iOS, Android, and Vega, and a per-platform key overrides it for that platform. That override is how a flow whose iOS bundle id differs from its Android package spells both:

```yaml
- launch: { native: com.acme.app, chromium: ../../app }
- launch: { ios: com.acme.app, android: com.acme.app.android, chromium: ../../app }
```

A launch that declares no id for the run's platform is an error, not a cue to switch platforms.

An Android app that must start on a non-launcher activity has no `launch:` form at all; record `restart-app` with its `activity` and accept that the flow is a fragment.

A `scroll-to` map is always the options form — the target goes under `target:`. Only the bare-string form (`scroll-to: Logout`) omits it, and that spelling is a loose selector.

`tap`, `type`, and `long-press` do not auto-scroll. Add `scroll-to` first whenever the target may be off-screen. Its `direction` is `up`, `down`, `left`, or `right`, and defaults to `down`; set it explicitly to reach a target above the viewport or along a horizontal carousel. `scroll-to` is a no-op if the target is already visible, and needs `within` for a nested scroller.

`type` presses Enter unless `submit: false`. A polished focus-tap + raw keyboard pair normally needs `submit: false`, because the recording did not submit.

Store secrets as `{{secret:APP_PASSWORD}}`, so one flow runs unchanged in CI and locally. The runner reads the first source that defines the name:

1. the `ARGENT_SECRET_APP_PASSWORD` environment variable;
2. `<project>/.argent/secrets.env`;
3. `<project>/.env.local`, then `<project>/.env`;
4. `~/.argent/secrets.env`.

The two dedicated `secrets.env` files accept the bare name `APP_PASSWORD`. The shared dotenv files expose **only** `ARGENT_SECRET_`-prefixed keys, so a bare `APP_PASSWORD=…` in `.env` or `.env.local` is ignored and the placeholder stays unresolved. Use `{{secret:…}}` for any external value, not only sensitive ones — but every resolved value is redacted from output, so never use it for something a report must show.

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
- await: { idle: true, stableFor: 400, timeout: 9000 }
```

The pixel half is why it exists: an iOS push or modal dismissal commits its hierarchy up front and then animates a layer for a few hundred milliseconds, and a cross-fade or scrim moves no node at all. A tree-only wait returns mid-transition.

`stableFor` (default 250) is how long stillness must hold. `timeout` (default 7500) is the budget for the whole wait, and the parser rejects one that cannot contain a settle. A settle spans three reads across two 200ms polls. The floor is the longer of `stableFor` and the 400ms a settle spans, plus the 200ms of budget the closing round needs to start. The hold runs **during** those polls rather than after them, so the two costs overlap and only the longer one counts: the default 250ms hold needs 600ms and an 800ms hold needs 1000ms.

Stillness is measured across intervals, so a settle takes at least three reads: `stableFor: 0` means "the first two agreeing intervals", not "the first read".

It has no `assert` form — waiting is the whole point — and no `when:` form. Prefer it over `wait:` for any transition with no element to gate on.

It **never fails a run.** Readiness is not an acceptance criterion, so every outcome short of a clean settle passes carrying a `warning` on the step. Read it rather than stepping over it:

- **the screen never held still** — it spent the timeout and went ahead, and was still moving on the last interval. Healthy screens often never stop (a video, a shimmer, a carousel, live-updating text, which on Android moves the tree as well as the pixels), and a screen that never finished loading looks exactly the same from here.
- **a small part of it was still changing** — a spinner, a caret, a progress dot, moving through the stretch of stillness the step settled on. Too small to be the screen moving, so the settle completed anyway; if it is a loading spinner, the screen was still loading when this step returned.
- **the screen was still for the last Nms** — the wait ran out mid-hold, so the settle was never confirmed. The warning names the term that was short: a second agreeing interval, because one alone can be two samples either side of an animation's turning point, or the rest of `stableFor`. Raise this step's `timeout:` — here the wait was too short, not the screen too busy.
- **the tree stayed empty** — the screen rendered no accessible content. Sometimes the app (a canvas, a video surface), sometimes a screen that never arrived.
- **settled on the UI tree alone** — no screenshot could be read often enough to compare a pair, so the hierarchy held still but presentation-layer motion above it (a push, a fade, a dismissing modal) was never waited out.
- **too few reads** — a settle needs three of them spanning two intervals, and this step got fewer, so it ended without evidence either way. A slow tree source, or a window blank for most of the wait.

Only a tree source that cannot be read stops the run, as an `errored` step — one that is still failing when the wait ends, one that answers and then wedges, one that answers with an empty tree it flags as degraded (an unattached Vega toolkit, an AX service asking to be relaunched), or one that never answers within the step (that last may simply be slow: raise `timeout` before suspecting the app). That is a broken window, not a verdict about the app: the run is not ok and every later step is skipped. A single failed read is not that window: the hold restarts from the next good one, and a read that fails at the very end of the wait is named in the warning rather than stopping the run.

One more limit: it says nothing about **which** screen settled, so it never replaces the identity gate.

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

A `run:` target is a YAML path resolved against the directory of the flow file that contains the step, so `../shared/login.yaml` reaches a sibling directory rather than the project root. The `.yaml` suffix is optional: `run: login` and `run: login.yaml` both name `login.yaml` beside the flow.

- iOS/Android e2e flows may run fragments or other e2e flows inline; a nested e2e launch restarts its app.
- Chromium boots one instance per launch **step**, not one per run. The leading launch — the flow's own, or the one its leading `run:` chain reaches — boots before step 1, unless you pinned the run with an explicit `device`, in which case that first launch only attaches to the instance you pinned. Every later launch boots a fresh instance, moves the run onto it, and tears down the instance the run already owned for that app path. Nesting a Chromium e2e flow with its own launch is therefore the supported way to give a sub-scenario its own app restart. `pinch` and `rotate` are rejected there — drive the app's own zoom or rotate controls instead.
- Vega is remote-driven. The touch directives (`tap`, `long-press`, `type`, `scroll-to`, `pinch`, `rotate`) are unsupported; record `tool: tv-remote` and raw `tool: keyboard`, then gate every focus/navigation result with `await`.

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

For iOS, Android, or Vega, record the seeding run's `--platform` and `--device` values and pass the same flags in CI so the device class stays pinned. For Chromium the class is the window's own pixel size, which the app sets and no launch argument changes: run with `--platform chromium` and omit `--device` so the runner boots the declared app path, rather than attaching to a running window of some other size. A window sized from host or session state produces a key CI cannot reproduce, and the step then fails for a missing baseline. The runner pins the iOS/Android status bar during a run to keep clock, battery, and signal changes out of full-screen visual diffs.

`--output <dir>` writes failed snapshot baseline/current/diff images under `<dir>/<flow>/`, a stable directory for CI artifact upload.

## YAML safety

Quote strings containing `#`, `:`, or quotes. A bare `true`/`false` or a number in a text slot is rejected at parse, so quote those too; `yes`/`no`/`on`/`off` parse as plain strings. Use single quotes for regex containing backslashes.

Parse failures include invalid directives, selector shapes, regexes, `else`, unsupported options, and an e2e flow that combines a leading `launch:` with `executionPrerequisite`.
