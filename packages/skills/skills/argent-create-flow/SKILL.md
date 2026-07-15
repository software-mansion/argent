---
name: argent-create-flow
description: Record a reusable flow (scripted sequence of MCP tool calls) that can be replayed later with a single command. Use when the user asks to create, record, or build a flow, or to script a sequence of device actions. Also used proactively, without an explicit request, when a multi-step interaction sequence is about to be repeated (re-profiling, re-testing, or a complex path worth saving).
---

## Overview

A flow is a sequence of steps saved to a `.yaml` file in the `.argent/flows/` directory. Each recorded step is **executed live** as you add it, so you verify it works before it becomes part of the flow. Replay a finished flow with `flow-execute`, or — for an e2e flow — headlessly with `argent flow run <name>`.

Flows store **no device id**: the runner binds a device (the single booted one, or pass `device`/`platform`). A recorded coordinate `gesture-tap` is captured as a portable `tap: { selector }` step whenever the tapped element has stable text/identifier.

**Two flow types**

- **e2e** — begins with a `launch:` step, which starts that app from scratch (terminate + relaunch), so the flow controls its own start state. No `executionPrerequisite`. May `run:` fragments; cannot itself be a `run:` target. Record one by adding a `restart-app` of the app under test as the **first** step — it is captured as the `launch` step.
- **fragment** — doesn't begin with a launch; runs against the device's current state. May declare an `executionPrerequisite` (a documented entry-state contract). Invoked from other flows via a `run:` step, or directly by you at any time.

Both run via `argent flow run <name>` — a fragment simply runs against whatever is on screen (its prerequisite is printed as a reminder). Only e2e flows are meaningful CI/suite entries, since only they give a deterministic verdict from a clean start.

### Step directives

Beyond raw `tool:` steps and `echo:`, flows support declarative directives interpreted by the runner (they are **not** agent-callable tools). **Every directive hard-stops the flow on failure**; later steps are reported `skip`.

| Directive    | YAML                                                                                                     | Meaning                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `launch`     | `- launch: com.acme.app` or `- launch: { ios: …, android: … }`                                           | start the app from scratch (terminate + relaunch) and wait until ready  |
| `tap`        | `- tap: Login`, `- tap: { x: 0.5, y: 0.57 }`, `- tap: { on: Login, times: 2 }`                           | tap by selector (auto-waits) or raw point; `times: 2` = double-tap      |
| `long-press` | `- long-press: Row 3` or `- long-press: { on: <sel>, duration: 1200 }`                                   | press and hold an element (default 800ms; Chromium: mouse press-hold)   |
| `type`       | `- type: { into: email, text: "a@b.com" }`                                                               | focus a field, type, then press Enter to submit + dismiss the keyboard  |
| `scroll-to`  | `- scroll-to: "Order #1234"` (scrolls down) or `- scroll-to: { target: …, direction: right, within: … }` | momentum-free scroll until the target is visible                        |
| `await`      | `- await: { visible: Home }`                                                                             | wait for a UI condition                                                 |
| `wait`       | `- wait: 500`                                                                                            | pause for a fixed number of milliseconds (last resort — prefer `await`) |
| `assert`     | `- assert: { visible: Welcome }`                                                                         | check a condition, hard-fail if it never holds                          |
| `snapshot`   | `- snapshot: home` or `- snapshot: { name: home, maxMismatch: 0.5 }`                                     | diff a screenshot against a stored baseline                             |
| `run`        | `- run: login`                                                                                           | execute a fragment's steps inline                                       |

### Selectors

A **selector** is `{ text?, id?, role? }` (all-must-match; `text`/`role` are case-insensitive substrings, `id` matches the element's testID / accessibilityIdentifier / resource-id exactly, case-insensitive, also accepting the unqualified Android resource-id name — `submit` matches `com.example.app:id/submit`) — the same semantics `await-ui-element` uses, though that tool spells the `id` field `identifier` (flow YAML also accepts `identifier` as an alias for `id`, but `id` is the canonical spelling and what the recorder writes). A bare string is a _loose_ selector: it resolves **identifier-first, then falls back to text** (label/value), so `tap: Login` matches a `testID="Login"` or, failing that, visible text "Login" — no need to know which. Loose fallback applies uniformly to every selector slot (`tap`, `type.into`, `await`, `assert`, `scroll-to`). Use the map form to be strict: `{ id: submit-btn }` (identifier only) or `{ text: Login }` (text only, no fallback).

`text` also takes a **regex matcher map** — `{ text: { matches: '^Order #\d+$' } }`, in any selector slot — for dynamic text no literal can pin. It tests each node's native **own** label/value (not the adapter-hoisted `subtreeText`), though on iOS a container's own label may itself aggregate descendant text, so a wrapper and its leaf can both match. Same regex rules as `text.in`'s `matches` (see _`await` and `assert`_): unanchored, **case-sensitive**, single-quoted, invalid pattern fails at parse. So `assert: { visible: { text: { matches: '^Taps: \d+$' } } }` asserts a counter is on screen with no locator at all, and `tap: { text: { matches: '^Order #\d+$' } }` taps a dynamic row — though a stable `id` stays the more robust action target.

Selectors resolve against the **full native hierarchy** (iOS: the UIView tree; Android: the complete accessibility hierarchy including not-important views) — strictly more than `describe` or the raw `await-ui-element` tool see (both use the trimmed tree), with complete `testID`/`resource-id` coverage. So an `id` selector works even when `describe` collapses or omits the element — don't fall back to coordinate taps just because a testID isn't visible in `describe` output. And when several elements match — including wrappers whose native text aggregates descendant content — the action directives (`tap`, `type`, `scroll-to`) pick the **most specific** match: an exact text/identifier match beats a substring hit (for a regex matcher, a pattern consuming the element's whole text counts as exact), then the smallest frame wins.

**Quote strings YAML would mangle.** An unquoted `#` starts a YAML comment — `tap: Order #1234` silently parses as `tap: Order` — and bare `yes`/`no`/`on`/`off`/numbers coerce to non-strings. When a selector or typed text contains `#`, `:`, quotes, or could read as a boolean/number, wrap it: `tap: "Order #1234"`.

### `await` and `assert`

The **condition is the key**, and its value is the selector:

- `{ visible: Home }`, `{ exists: { id: row } }`, `{ hidden: spinner }`
- `{ text: { in: <selector>, contains: "Taps:" } }` or `{ text: { in: <selector>, equals: "Taps: 0" } }` — `text` locates an element (`in`) and checks its rendered content against exactly one of `contains` (case-insensitive substring) or `equals` (case-insensitive exact match — use it when boundaries matter: `contains: "Taps: 3"` is also satisfied by "Taps: 30"). Reach for `text` only when the locator is an identifier/role; to assert a string is simply on screen, prefer `{ visible: "Taps: 0" }`.
- `{ text: { in: total, matches: 'Total: \$\d+\.\d{2}' } }` — the third comparator: a JS regex for dynamic content (counters, prices, dates) that neither literal mode can pin. Unanchored like `contains` (anchor with `^…$` for the `equals` analog) and — unlike the literal modes — **case-sensitive**: the pattern carries its own semantics. An invalid pattern fails at parse time. **Quote the pattern in single quotes**: single-quoted and plain YAML scalars keep backslashes; double quotes would need `\\d`. To assert a dynamic string is simply on screen with no locator, prefer a regex **selector** — `{ visible: { text: { matches: '^Taps: \d+$' } } }` (see Selectors); `text.in` + `matches` is for checking a specific element's aggregated text.
- A container's text aggregates its descendants' text (space-joined), so `text` can assert what a testID wrapper visibly shows even when the string lives in a child node. That also means `equals` against a wrapper must match _everything_ it shows or exactly the wrapper's own label/value — targeting the leaf holding exactly the value (or using `contains`) stays the clearer spelling.

This condition-as-key form is the only spelling. `await` also accepts an optional `timeout` sibling key in milliseconds — `- await: { visible: Home, timeout: 15000 }` — for a transition that legitimately needs longer than the default budget. **Omit `timeout` by default**: the default budget covers normal transitions, and a habitual generous override just delays failure reporting on every broken step. Add one only after a step demonstrably needs it — it timed out at the default and the wait is legitimately slow (a cold start, a network round-trip, a long animation). `assert` has no timeout override: a check that needs seconds to become true is a wait — spell it `await`.

For a custom poll interval or bundleId, drop to an explicit `- tool: await-ui-element` step — but the raw tool polls the trimmed `describe` tree, so a testID it reports as not found can still resolve fine as an `await:` directive (see Selectors). Prefer the directive.

### `type` and `scroll-to`

`type` presses Enter after typing to commit the value and dismiss the keyboard, so it can't cover later targets. For a chained form whose fields feed one explicit submit — e.g. email then password then a `tap: "Log in"` — set `submit: false` on the intermediate fields so a premature Enter doesn't fire the form early: `type: { into: password, text: "hunter2", submit: false }`.

Never record a real credential into a flow — the YAML is committed to the repo. Use a secret placeholder instead: `type: { into: password, text: "{{secret:APP_PASSWORD}}" }`. The placeholder is stored verbatim (the YAML stays secret-free) and is resolved at run time by the tool-server from the `ARGENT_SECRET_APP_PASSWORD` environment variable — including agent-less `argent flow run` in CI, where the variable comes from the job's secrets.

`scroll-to` takes an optional `direction` (`up` | `down` | `left` | `right`, default `down` — so the common case is just `- scroll-to: <selector>`) and optionally a `within: <selector>` that anchors the scroll inside a specific container — required to drive a **nested** scroller (e.g. a horizontal carousel inside a vertical list), since the device can't be asked which container to scroll. It scrolls in bounded momentum-free increments, re-checks after each, and stops if a scroll reveals nothing new (end of the container). `tap`/`type` do **not** scroll — add a `scroll-to` before any target that may be off-screen. It's a no-op when the target is already visible, so a defensive `scroll-to` costs nothing on replay and keeps the flow working on smaller screens.

### TV targets (Vega)

A Vega (Fire TV) device is remote-driven — there is no touch input, so the touch directives (`tap`, `long-press`, `type`, `scroll-to`) fail on it with guidance. Drive focus with `tool: tv-remote` steps and type with `tool: keyboard` instead; everything else (`launch`, `await`, `assert`, `wait`, `snapshot`, `echo`, `run`, selectors) works unchanged — the tree comes from the on-device automation toolkit, which attaches at app launch (the `launch` step waits for it, so a leading `launch` also guarantees selectors resolve).

```yaml
steps:
  - launch: com.example.app.main # the interactive component id from manifest.toml
  - await: { visible: Home }
  - tool: tv-remote
    args: { button: [down, select] } # move focus, then confirm — one step per navigation
  - await: { visible: Explore Screen }
  - snapshot: explore
```

Since a `tv-remote` path is positional (like a coordinate tap), gate each navigation with an `await` on the destination screen and echo where focus should be — that is what makes the flow diagnosable when the focus order changes.

### Standalone runner

`argent flow run <name> [--device <id>] [--platform ios|android|chromium|vega] [--update-baselines] [--output <dir>] [--json]` runs a flow with no LLM in the loop and exits non-zero on any failure — suitable for CI (e2e flows; a fragment runs against the current device state, useful while authoring). `snapshot` baselines live in `.argent/flows/__baselines__/<flow>/`, keyed by platform + resolution; a `snapshot` step **fails** when no baseline exists for the run's device class, so seed baselines with `--update-baselines` and have the user review and commit `__baselines__/` — and pin the device class in CI (`--device`/`--platform`, same simulator model) so runs compare against the committed key. The status bar is pinned (iOS `simctl status_bar`, Android demo mode) for the run so it doesn't drive visual diffs. `--output <dir>` writes each failed snapshot's baseline/current/diff images to `<dir>/<flow>/` — a stable path for CI artifact upload.

## Tools

| Tool                     | Purpose                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `flow-start-recording`   | Start recording — takes a name and (fragments only) an optional `executionPrerequisite`; creates the file |
| `flow-add-step`          | Execute a tool call live and record it if it succeeds                                                     |
| `flow-add-echo`          | Add a label/comment that prints during replay                                                             |
| `flow-finish-recording`  | Stop recording and get a summary                                                                          |
| `flow-read-prerequisite` | Read a flow's execution prerequisite without running it                                                   |
| `flow-execute`           | Replay a saved flow by name                                                                               |

Every tool during recording returns the current flow file contents, so you can track what has been recorded. Rules:

- **Every step runs live.** You see the real tool result (including screenshots) — verify the step worked before continuing. **Only successful steps are recorded**: a failed call writes nothing to the flow file; fix the issue and try again.
- **Pass `project_root` once.** Give the absolute `project_root` (an error is returned if the path is not absolute) to `flow-start-recording` — it is stored for the session and used by all subsequent flow tools. You do **not** pass a flow name to `flow-add-step`, `flow-add-echo`, or `flow-finish-recording` — the active flow is tracked automatically.
- **Start before adding.** Calling those tools without an active recording returns _"No active flow. Call flow-start-recording first."_
- **One flow at a time.** `flow-start-recording` while already recording switches to the new flow — the response tells you which flow was abandoned and which is now active; the old flow's file remains on disk.
- **Mistakes can be edited out.** Edit the `.yaml` file directly to remove or reorder steps.

### flow-add-step arguments

The `command` parameter is the MCP tool name; `args` is a **JSON string** (not an object), omitted entirely for tools with no arguments:

```
command: "gesture-tap"
args: "{\"udid\": \"<UDID>\", \"x\": 0.5, \"y\": 0.35}"

command: "await-ui-element"
args: "{\"udid\": \"<UDID>\", \"condition\": \"visible\", \"selector\": {\"text\": \"Continue\"}}"
```

Record an `await-ui-element` step to **gate** the next step on a screen transition — it blocks until the element is `visible`/`hidden` (or contains `text`), so the following step runs only once the screen has actually settled; prefer this over a fixed `delayMs`. If its condition is not met before the timeout, replay **stops at that step** (the steps after it assume the transition happened). See the `await-ui-element` section of `argent-device-interact` for the full condition/selector reference. The live call sees only the trimmed `describe` tree — if it can't find an identifier you know exists, gate on visible text to get the step recorded, then retarget the identifier in the `await:` form during polish (the directive resolves the full hierarchy — see Selectors); don't conclude the testID is unusable in the flow.

## Recording

1. **Start, then launch as the first step (e2e) or set the stage yourself (fragment).** Call `flow-start-recording` with a descriptive name and the absolute `project_root`. For an **e2e** flow, record a `restart-app` of the app under test as the **first** step — it runs live (resetting the device for the rest of the recording) and is captured as the flow's `launch` step. For a **fragment**, bring the device to the entry state _before_ recording and pass an `executionPrerequisite` describing it (e.g. "App on the login screen") to `flow-start-recording` instead.
2. **Build step-by-step**: for each action, call `flow-add-step` with the tool name and args. The tool runs immediately — check the result before moving on, and gate each navigation with an `await-ui-element` step.
3. **Add labels**: use `flow-add-echo` between steps — echo the expected state, not just the action (see _Making flows resilient_).
4. **Finish**: call `flow-finish-recording`. It returns the file path where the flow was saved and a summary of all steps.
5. **Polish**: **read the saved `.yaml` file** and convert the raw `tool:` steps that have a cleaner directive form (the recorder leaves these as tools):
   - `tool: keyboard` typing into a field → `type: { into: "<field>", text: "…" }`, folding in the `tap` that focused the field.
   - `tool: await-ui-element` gating a transition → `await: { visible: "…" }` / `{ hidden: … }` / `{ text: { in: …, equals: … } }`, carrying a custom `timeoutMs` over as a `timeout` sibling key. Converting also upgrades the wait from the trimmed `describe` tree to the flow's full-hierarchy tree (see Selectors). Keep the raw `tool: await-ui-element` step only when it sets a custom `pollIntervalMs`/`bundleId` the directive can't express.
   - A scroll-to-reach-an-element — a `tool: gesture-swipe` used to bring a specific element on screen before interacting with it (a `tap`, `type`, `assert`, …) → `scroll-to: { target: "<that element>", direction: … }`, dropping the swipe. This is far more robust than a fixed-distance swipe: it scrolls momentum-free and stops exactly when the target appears, so it survives layout and content changes. (`tap`/`type` do not scroll, so a raw swipe whose fling lands differently on another device leaves the following tap unresolved — always prefer the `scroll-to` rewrite.) Keep a `gesture-swipe` as a raw `tool:` step when it isn't scrolling toward a specific element — especially a velocity-dependent gesture like swipe-to-dismiss, edge-swipe-back, or swipe-to-reveal a row action, which a momentum-free `scroll-to` would not reproduce.

Every other recorded tool (`gesture-swipe`, `gesture-scroll`, `button`, `screenshot`, …) has no directive form — leave it as a `tool:` step. The recorder already handles the rest: coordinate `gesture-tap`s are captured as portable `tap:` selector steps, a `restart-app` is captured as a `launch:` step, a `flow-execute` of a sibling fragment is captured as a `run: <name>` composition directive, and device ids are stripped. Captured selectors are emitted in the strict map form (`tap: { text: General }`), never as a loose bare string — the recorder verified the exact element the tap hit, and a bare string would re-parse as loose and route through the identifier-first fallback it was never checked against. After editing, re-run with `flow-execute` to confirm the cleaned flow still passes.

### Example session

```
flow-start-recording  { name: "open-about", project_root: "/Users/dev/MyApp" }
flow-add-echo  { message: "Start Settings from scratch" }
flow-add-step  { command: "restart-app", args: "{\"udid\": \"ABC\", \"bundleId\": \"com.apple.Preferences\"}" }   # ⇒ captured as `- launch: com.apple.Preferences` — this is now an e2e flow
flow-add-echo  { message: "On the Settings root list, tapping the 'General' row" }
flow-add-step  { command: "gesture-tap", args: "{\"udid\": \"ABC\", \"x\": 0.5, \"y\": 0.35}" }   # ⇒ captured as `- tap: { text: General }` (portable selector, no udid)
flow-add-step  { command: "await-ui-element", args: "{\"udid\": \"ABC\", \"condition\": \"visible\", \"selector\": {\"text\": \"About\"}}" }   # gate the transition
flow-add-echo  { message: "On Settings > General, tapping 'About'" }
flow-add-step  { command: "gesture-tap", args: "{\"udid\": \"ABC\", \"x\": 0.5, \"y\": 0.17}" }
flow-add-step  { command: "await-ui-element", args: "{\"udid\": \"ABC\", \"condition\": \"visible\", \"selector\": {\"text\": \"Model Name\"}}" }
flow-finish-recording  {}
```

Then polish the saved file: the two `await-ui-element` steps become `await:` directives (see the file below).

## Replaying

Call `flow-execute` with the flow name (and `project_root`, unless a recording this session already stored it). If the flow has an execution prerequisite, the tool returns a **notice** with the prerequisite text instead of running — verify the prerequisite is met (you can also inspect it beforehand with `flow-read-prerequisite`) and call `flow-execute` again with `prerequisiteAcknowledged: true`. A flow without a prerequisite runs immediately. The run executes all steps in order and returns a structured report: `{ ok, passed, failed, skipped, errored, steps }`.

**What each step reports.** Raw `tool:` steps include the underlying tool's full `result` (screenshots and other outputs render as usual). The directive steps are summarized: `tap`/`type`/`await`/`assert` report only `status` + `reason`, and `snapshot` adds `artifacts` only when there is something to look at — a failed comparison (baseline/current/diff paths), a missing-baseline failure (`current` only), or a baseline write; a clean pass reports just `status` + `reason`. So converting a `tool: gesture-tap` into a `tap:` directive during cleanup drops only that tap's (uninteresting) raw result — output-bearing tools like `screenshot` have no directive form and stay `tool:` steps, so their results keep flowing through.

## Flow file format

The top-level is an object with `steps` (array) and — fragments only — `executionPrerequisite` (an e2e flow, one beginning with `launch:`, has none). Besides the directives above:

- `- echo: <message>` — a label printed during replay
- `- tool: <name>` with optional `args:` — a raw tool call. A tool step may also carry `delayMs: <ms>` to sleep that long before it runs. (`await-ui-element` is an ordinary tool step; see _flow-add-step arguments_ and _Making flows resilient_ for when to gate a transition with one.)

The polished result of the example session above:

```yaml
steps:
  - echo: Start Settings from scratch
  - launch: com.apple.Preferences
  - echo: On the Settings root list, tapping the 'General' row
  - tap: { text: General }
  - await: { visible: About }
  - echo: On Settings > General, tapping 'About'
  - tap: { text: About }
  - await: { visible: Model Name }
```

Note there is **no device id** anywhere in the file — the recorder strips them and the runner injects the bound device.

## When to proactively record a flow

Proactive recording is part of this skill's scope (see the description). Record a flow without waiting to be asked — telling the user you are doing so — when you recognize any of these patterns:

- **About to re-profile**: You completed a profiling session and are about to apply a fix and re-profile. Record the interaction steps now so the re-profile replays them identically (see `argent-react-native-profiler` and `argent-native-profiler` skills).
- **Repeating steps**: You have already performed a multi-step interaction sequence once and the task requires doing it again (comparison, retry, re-test).
- **Complex path discovered**: You worked through a non-trivial sequence of taps/swipes/navigation to reach a desired app state. Capture it before it is lost.
- **User says "again" / "one more time"**: Any request to redo what you just did is a signal to record first, then replay.

## Flow self-improvement

Flows break. UI layouts change, coordinates drift, screens get added or removed. When `flow-execute` returns a failure, follow this procedure to diagnose and fix the flow instead of silently re-recording or giving up.

### Classify the result

After every `flow-execute`, classify the outcome before proceeding:

| Outcome                | Signal                                                                | Action             |
| ---------------------- | --------------------------------------------------------------------- | ------------------ |
| **Success**            | All steps completed, final screenshot shows expected state            | Continue with task |
| **Hard error**         | A step has `ERROR` in the result — engine stopped there               | Enter **Diagnose** |
| **Silent misfire**     | All steps completed but final screenshot shows wrong screen           | Enter **Diagnose** |
| **Partial divergence** | Intermediate screenshot shows wrong state even though later steps ran | Enter **Diagnose** |

For silent misfires and partial divergence, echo annotations (see _Making flows resilient_) are your reference for what each screen _should_ look like.

### Diagnose

1. Note the failure step index and error message (if hard error).
2. Call `screenshot` to see where the app actually is now.
3. Call `describe` or `debugger-component-tree` to get the current element tree. Remember `describe` shows less than the flow tree — a testID missing from its output can still resolve as a selector (see Selectors).
4. Compare current state to what the failed step expected. Classify the root cause:

| Root cause       | Symptoms                                                        |
| ---------------- | --------------------------------------------------------------- |
| Coordinate drift | Tap succeeded but hit wrong element; elements shifted positions |
| Missing element  | Target element not present in element tree                      |
| Wrong screen     | Screenshot shows entirely different page than expected          |
| Timing           | Element exists in tree but tap missed; loading spinner visible  |
| State mismatch   | First step fails — executionPrerequisite was not actually met   |

5. State the diagnosis in one sentence before attempting any correction.

### Correct

Choose the lightest strategy that fits:

**Strategy 1 — Edit the YAML** (coordinate drift, parameter changes).
Read `.argent/flows/<flow-name>.yaml`, update the broken step's `x`/`y`, `bundleId`, `text`, or other args. Re-run `flow-execute` to verify.

**Strategy 2 — Manual recovery + continue** (timing/transient issues, one-off replay).
Manually execute the failed step with corrected coordinates from the Diagnose step, then manually execute remaining steps. Does not fix the YAML — use only when re-recording is not worth it.

**Strategy 3 — Re-record from failure point** (structural changes, new intermediate screens).
Navigate the app to the state just before the failure point. Call `flow-start-recording` with the same flow name (overwrites). Re-add the working prefix steps via `flow-add-step`, then continue recording new steps from the divergence point. Call `flow-finish-recording`.

**Strategy 4 — Full re-record** (major changes, unclear diagnosis, or 3+ broken steps).
Reset the app to prerequisite state (`restart-app` + `launch-app`). Record from scratch with the same flow name.

**Decision heuristic:**

- 1 step broken, parameter-only change → Strategy 1
- 1 step broken, transient issue, not worth persisting → Strategy 2
- 2–3 steps broken or flow structure partially changed → Strategy 3
- 3+ steps broken, or unclear root cause → Strategy 4
- Flow used for profiling comparison (must be identical) → Strategy 4

### Verify and bound retries

After applying a correction, re-run `flow-execute` to verify.

- If it succeeds → done. Report what changed (e.g. "Fixed step 4: updated tap coordinates from 0.5,0.35 to 0.5,0.42").
- If it fails at a **different** step → return to Diagnose for a second attempt.
- If this is already the second correction attempt → **stop**. Report the diagnosis to the user and recommend a full re-record or manual investigation.

**Hard cap: 2 correction cycles.** Do not enter an unbounded fix loop.

### Making flows resilient

Apply these when recording new flows to reduce future breakage:

- **Echo expected state, not just actions.** Write `"On Settings > General screen, about to tap About"` not `"Tap About"`. During diagnosis these tell you what the screen _should_ look like.
- **Gate transitions with `await-ui-element`, not fixed delays.** After a tap that triggers a navigation, record an `await-ui-element` step that waits for the next screen's element to be `visible` (or a spinner to be `hidden`) before the following step — converted to an `await:` directive during polish. This removes the **Timing** failure mode in Diagnose (the element is in the tree but the tap fired before the screen settled) and is more reliable than `delayMs` or an extra `screenshot`. An unmet wait stops replay at that step, so a mistimed step can never run blind.
- **Add screenshot steps after critical navigation.** Insert `screenshot` steps after screen transitions. These produce images in the flow result you can inspect during diagnosis.
- **Write specific executionPrerequisites.** `"App on home tab, user logged in, simulator UDID is <X>"` — not `"App running"`. Verify with `screenshot` + `describe` before acknowledging.
- **Prefer launch-app / open-url over navigation chains.** Deep links are more resilient to layout changes than tap sequences.
- **Echo accessibility labels for coordinate taps.** When recording a tap, add an echo with the target's label or testID: `"Tapping 'Submit' button (testID: submit-btn) at 0.5, 0.82"`. During repair, use `describe` to find the element by label and update coordinates. Only use `screenshot` for permission or system overlays when `describe` cannot expose the target reliably.
