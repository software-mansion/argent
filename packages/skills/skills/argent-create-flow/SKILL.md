---
name: argent-create-flow
description: Record a reusable flow (scripted sequence of MCP tool calls) that can be replayed later with a single command. Use when the user asks to create, record, or build a flow, or to script a sequence of device actions.
---

## 1. Overview

A flow is a sequence of steps saved to a `.yaml` file in the `.argent/flows/` directory. Each recorded step is **executed live** as you add it, so you verify it works before it becomes part of the flow. Replay a finished flow with `flow-execute`, or — for an e2e flow — headlessly with `argent flow run <name>`.

Flows store **no device id**: the runner binds a device (the single booted one, or pass `device`/`platform`). A recorded coordinate `gesture-tap` is captured as a portable `tap: { selector }` step whenever the tapped element has stable text/identifier.

**Two flow types** 
- **e2e** — begins with a `launch:` step, which starts that app from scratch (terminate + relaunch), so the flow controls its own start state. No `executionPrerequisite`. May `run:` fragments; cannot itself be a `run:` target. Record one by adding a `restart-app` of the app under test as the **first** step — it is captured as the `launch` step.
- **fragment** — doesn't begin with a launch; runs against the device's current state. May declare an `executionPrerequisite` (a documented entry-state contract). Invoked from other flows via a `run:` step, or directly by you at any time.

Both run via `argent flow run <name>` — a fragment simply runs against whatever is on screen (its prerequisite is printed as a reminder). Only e2e flows are meaningful CI/suite entries, since only they give a deterministic verdict from a clean start.

### Step directives

Beyond raw `tool:` steps and `echo:`, flows support declarative directives interpreted by the runner (they are **not** agent-callable tools):

| Directive   | YAML                                                                                                     | Meaning                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `launch`    | `- launch: com.acme.app` or `- launch: { ios: …, android: … }`                                           | start the app from scratch (terminate + relaunch) and wait until ready  |
| `tap`       | `- tap: Login` or `- tap: { x: 0.5, y: 0.57 }`                                                           | tap an element by selector (auto-waits), or a raw normalized point      |
| `type`      | `- type: { into: email, text: "a@b.com" }`                                                               | focus a field, type, then press Enter to submit + dismiss the keyboard  |
| `scroll-to` | `- scroll-to: "Order #1234"` (scrolls down) or `- scroll-to: { target: …, direction: right, within: … }` | momentum-free scroll until the target is visible                        |
| `await`     | `- await: { visible: Home }`                                                                             | wait for a UI condition                                                 |
| `wait`      | `- wait: 500`                                                                                            | pause for a fixed number of milliseconds (last resort — prefer `await`) |
| `assert`    | `- assert: { visible: Welcome }`                                                                         | check a condition, hard-fail if it never holds                          |
| `snapshot`  | `- snapshot: home` or `- snapshot: { name: home, maxMismatch: 0.5 }`                                     | diff a screenshot against a stored baseline                             |
| `run`       | `- run: login`                                                                                           | execute a fragment's steps inline                                       |

A **selector** is `{ text?, identifier?, role? }` (case-insensitive substring, all-must-match) — the same shape `await-ui-element` uses. A bare string is a _loose_ selector: it resolves **identifier-first, then falls back to text** (label/value), so `tap: Login` matches a `testID="Login"` or, failing that, visible text "Login" — no need to know which. Loose fallback applies uniformly to every selector slot (`tap`, `type.into`, `await`, `assert`, `scroll-to`). Use the map form to be strict: `{ identifier: submit-btn }` (identifier only) or `{ text: Login }` (text only, no fallback).

**Quote strings YAML would mangle.** An unquoted `#` starts a YAML comment — `tap: Order #1234` silently parses as `tap: Order` — and bare `yes`/`no`/`on`/`off`/numbers coerce to non-strings. When a selector or typed text contains `#`, `:`, quotes, or could read as a boolean/number, wrap it: `tap: "Order #1234"`.

For `await`/`assert` the **condition is the key**, and its value is the selector:

- `{ visible: Home }`, `{ exists: { identifier: row } }`, `{ hidden: spinner }`
- `{ text: { in: <selector>, contains: "Taps:" } }` or `{ text: { in: <selector>, equals: "Taps: 0" } }` — `text` locates an element (`in`) and checks its rendered content against exactly one of `contains` (case-insensitive substring) or `equals` (case-insensitive exact match — use it when boundaries matter: `contains: "Taps: 3"` is also satisfied by "Taps: 30"). Reach for `text` only when the locator is an identifier/role; to assert a string is simply on screen, prefer `{ visible: "Taps: 0" }`.
- A container's text aggregates its descendants' text (space-joined), so `text` can assert what a testID wrapper visibly shows even when the string lives in a child node. That also means `equals` against a wrapper must match _everything_ it shows — target the leaf holding exactly the value, or use `contains`.

This condition-as-key form is the only spelling. For advanced `await` control beyond it (custom timeout, poll interval, bundleId), drop to an explicit `- tool: await-ui-element` step. **Every directive hard-stops the flow on failure**; later steps are reported `skip`. `flow-execute` returns a structured report: `{ ok, passed, failed, skipped, errored, steps }`.

`type` presses Enter after typing to commit the value and dismiss the keyboard, so it can't cover later targets. For a chained form whose fields feed one explicit submit — e.g. email then password then a `tap: "Log in"` — set `submit: false` on the intermediate fields so a premature Enter doesn't fire the form early: `type: { into: password, text: "hunter2", submit: false }`.

`scroll-to` takes an optional `direction` (`up` | `down` | `left` | `right`, default `down` — so the common case is just `- scroll-to: <selector>`) and optionally a `within: <selector>` that anchors the scroll inside a specific container — required to drive a **nested** scroller (e.g. a horizontal carousel inside a vertical list), since the device can't be asked which container to scroll. It scrolls in bounded momentum-free increments, re-checks after each, and stops if a scroll reveals nothing new (end of the container). `tap`/`type` also auto-scroll a target into view (vertical) before resolving, so an explicit `scroll-to` is only needed for a horizontal scroll, a nested container, or to make the intent visible in the flow.

### Standalone runner

`argent flow run <name> [--device <id>] [--platform ios|android|chromium] [--update-baselines] [--json]` runs a flow with no LLM in the loop and exits non-zero on any failure — suitable for CI (e2e flows; a fragment runs against the current device state, useful while authoring). `snapshot` baselines live in `.argent/flows/__baselines__/<flow>/`; the status bar is pinned (iOS `simctl status_bar`, Android demo mode) for the run so it doesn't drive visual diffs.

## 2. Tools

| Tool                     | Purpose                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `flow-start-recording`   | Start recording — takes a name and (fragments only) an optional `executionPrerequisite`; creates the file |
| `flow-add-step`          | Execute a tool call live and record it if it succeeds                                                     |
| `flow-add-echo`          | Add a label/comment that prints during replay                                                             |
| `flow-finish-recording`  | Stop recording and get a summary                                                                          |
| `flow-read-prerequisite` | Read a flow's execution prerequisite without running it                                                   |
| `flow-execute`           | Replay a saved flow by name                                                                               |

## 3. Workflow

### Recording

1. **Start, then launch as the first step (e2e) or set the stage yourself (fragment).** Call `flow-start-recording` with a descriptive name and the absolute `project_root` (stored for the session — you do **not** need to pass it again). For an **e2e** flow, record a `restart-app` of the app under test as the **first** step — it runs live (resetting the device for the rest of the recording) and is captured as the flow's `launch` step. For a **fragment**, bring the device to the entry state _before_ recording and pass an `executionPrerequisite` describing it (e.g. "App on the login screen") to `flow-start-recording` instead.
2. **Build step-by-step**: For each action, call `flow-add-step` with the tool name and args. The tool runs immediately — check the result before moving on.
3. **Add labels**: Use `flow-add-echo` between steps to describe what each section does.
4. **Finish**: Call `flow-finish-recording` to stop recording. It returns the file path where the flow was saved and a summary of all steps.
5. **Polish**: **Read the saved `.yaml` file** and convert the raw `tool:` steps that have a cleaner directive form (the recorder leaves these as tools):
   - `tool: keyboard` typing into a field → `type: { into: "<field>", text: "…" }`, folding in the `tap` that focused the field.
   - `tool: await-ui-element` gating a transition → `await: { visible: "…" }` / `{ hidden: … }` / `{ text: { in: …, equals: … } }`. Keep the raw `tool: await-ui-element` step only when it sets a custom `timeoutMs`/`pollIntervalMs`/`bundleId` the sugar can't express.

   - A scroll-to-reach-an-element — a `tool: gesture-swipe` used to bring a specific element on screen before interacting with it (a `tap`, `type`, `assert`, …) → `scroll-to: { target: "<that element>", direction: … }`, dropping the swipe. This is far more robust than a fixed-distance swipe: it scrolls momentum-free and stops exactly when the target appears, so it survives layout and content changes. (`tap`/`type` also auto-scroll vertically, so even leaving the raw swipe + tap often works — but `scroll-to` is deterministic and self-documenting.) Keep a `gesture-swipe` as a raw `tool:` step when it isn't scrolling toward a specific element — especially a velocity-dependent gesture like swipe-to-dismiss, edge-swipe-back, or swipe-to-reveal a row action, which a momentum-free `scroll-to` would not reproduce.

Every other recorded tool (`gesture-swipe`, `gesture-scroll`, `button`, `screenshot`, …) has no directive form — leave it as a `tool:` step. The recorder already handles the rest: coordinate `gesture-tap`s are captured as portable `tap:` selector steps, a `restart-app` is captured as a `launch:` step, a `flow-execute` of a sibling fragment is captured as a `run: <name>` composition directive, device ids are stripped, and text-only selectors are emitted as bare strings. After editing, re-run with `flow-execute` to confirm the cleaned flow still passes.

Every tool during recording returns the current flow file contents so you can track what has been recorded.

### Replaying

Call `flow-execute` with the flow name. If the flow has an execution prerequisite:

1. The tool returns a **notice** with the prerequisite text instead of running. It asks you to verify the prerequisite is met and call `flow-execute` again with `prerequisiteAcknowledged: true`.
2. You can also call `flow-read-prerequisite` beforehand to inspect the prerequisite without triggering a run.
3. Once you pass `prerequisiteAcknowledged: true`, the flow runs all steps in order and returns a structured report `{ ok, passed, failed, skipped, errored, steps }`.

If the flow has no prerequisite, it runs immediately without needing acknowledgment.

**What each step reports.** Raw `tool:` steps include the underlying tool's full `result` (screenshots and other outputs render as usual). The directive steps are summarized: `tap`/`type`/`await`/`assert` report only `status` + `reason`, and `snapshot` adds `artifacts` (diff image paths). So converting a `tool: gesture-tap` into a `tap:` directive during cleanup drops only that tap's (uninteresting) raw result — output-bearing tools like `screenshot` have no directive form and stay `tool:` steps, so their results keep flowing through.

## 4. flow-add-step Usage

The `command` parameter is the MCP tool name. The `args` parameter is a **JSON string** (not an object):

```
command: "launch-app"
args: "{\"udid\": \"<UDID>\", \"bundleId\": \"com.apple.Preferences\"}"
```

```
command: "gesture-tap"
args: "{\"udid\": \"<UDID>\", \"x\": 0.5, \"y\": 0.35}"
```

```
command: "screenshot"
args: "{\"udid\": \"<UDID>\"}"
```

```
command: "await-ui-element"
args: "{\"udid\": \"<UDID>\", \"condition\": \"visible\", \"selector\": {\"text\": \"Continue\"}}"
```

Record an `await-ui-element` step to **gate** the next step on a screen transition — it blocks until the element is `visible`/`hidden` (or contains `text`), so the following step runs only once the screen has actually settled. If its condition is not met before the timeout, replay **stops at that step** (the steps after it assume the transition happened). Prefer this over a fixed `delayMs`. See the `await-ui-element` section of `argent-device-interact` for the full condition/selector reference.

For tools with no arguments, omit `args` entirely.

## 5. Important Rules

- **Every step runs live.** You will see the real tool result (including screenshots). Use this to verify the step worked before continuing.
- **Only successful steps are recorded.** If a tool call fails, nothing is written to the flow file — fix the issue and try again.
- **Pass `project_root` only to `flow-start-recording`.** It is stored for the session and automatically used by all subsequent flow tools. An error is returned if the path is not absolute.
- **You do NOT need to pass a flow name** to `flow-add-step`, `flow-add-echo`, or `flow-finish-recording`. The active flow is tracked automatically after `flow-start-recording`.
- **Start before adding.** Calling `flow-add-step`, `flow-add-echo`, or `flow-finish-recording` without an active recording returns an error: _"No active flow. Call flow-start-recording first."_
- **One flow at a time.** If you call `flow-start-recording` while already recording, the active flow switches to the new one. The response tells you which flow was abandoned and which is now active. The old flow's file remains on disk.
- **Mistakes can be edited out.** If a step was recorded by mistake, edit the `.yaml` file directly to remove or reorder entries.

## 6. Example Session

```
flow-start-recording  { name: "open-settings", project_root: "/Users/dev/MyApp" }
flow-add-echo  { message: "Start Settings from scratch" }
flow-add-step  { command: "restart-app", args: "{\"udid\": \"ABC\", \"bundleId\": \"com.apple.Preferences\"}" }   # ⇒ recorded as `- launch: com.apple.Preferences` — this is now an e2e flow
flow-add-echo  { message: "Tap General" }
flow-add-step  { command: "gesture-tap", args: "{\"udid\": \"ABC\", \"x\": 0.5, \"y\": 0.35}" }
flow-add-echo  { message: "Tap About" }
flow-add-step  { command: "gesture-tap", args: "{\"udid\": \"ABC\", \"x\": 0.5, \"y\": 0.17}" }
flow-finish-recording  {}
```

## 7. Replay Example

```
flow-execute   { name: "open-settings", project_root: "/Users/dev/MyApp" }
→ Returns: notice with executionPrerequisite: "Simulator booted with app installed"
  "Verify the prerequisite is met and call flow-execute again with prerequisiteAcknowledged set to true."

flow-execute   { name: "open-settings", project_root: "/Users/dev/MyApp", prerequisiteAcknowledged: true }
→ Runs all steps, returns merged results with status and output for every step
```

## 8. Flow File Format

Flow files use YAML. The top-level is an object with `executionPrerequisite` (describes required state) and `steps` (array of actions):

- `- echo: <message>` — a label
- `- tool: <name>` with optional `args:` — a tool call. A tool step may also carry `delayMs: <ms>` to sleep that long before it runs. (`await-ui-element` is an ordinary tool step; see §4 and §10.5 for when to gate a transition with one.)

Example `.yaml` file:

```yaml
executionPrerequisite: Simulator booted with app installed
steps:
  - echo: Launch Settings app
  - tool: launch-app
    args:
      udid: ABC
      bundleId: com.apple.Preferences
  - echo: Wait for the Settings list to render
  - tool: await-ui-element
    args:
      udid: ABC
      condition: visible
      selector:
        text: General
  - echo: Tap General
  - tool: gesture-tap
    args:
      udid: ABC
      x: 0.5
      y: 0.35
  - echo: Tap About
  - tool: gesture-tap
    args:
      udid: ABC
      x: 0.5
      y: 0.17
```

## 9. When to Proactively Record a Flow

You do not need the user to ask for a flow. Record one proactively when you recognize any of these patterns:

- **About to re-profile**: You completed a profiling session and are about to apply a fix and re-profile. Record the interaction steps now so the re-profile replays them identically (see `argent-react-native-profiler` and `argent-native-profiler` skills).
- **Repeating steps**: You have already performed a multi-step interaction sequence once and the task requires doing it again (comparison, retry, re-test).
- **Complex path discovered**: You worked through a non-trivial sequence of taps/swipes/navigation to reach a desired app state. Capture it before it is lost.
- **User says "again" / "one more time"**: Any request to redo what you just did is a signal to record first, then replay.

## 10. Flow Self-Improvement

Flows break. UI layouts change, coordinates drift, screens get added or removed. When `flow-execute` returns a failure, follow this procedure to diagnose and fix the flow instead of silently re-recording or giving up.

### 10.1 Classify the Result

After every `flow-execute`, classify the outcome before proceeding:

| Outcome                | Signal                                                                | Action             |
| ---------------------- | --------------------------------------------------------------------- | ------------------ |
| **Success**            | All steps completed, final screenshot shows expected state            | Continue with task |
| **Hard error**         | A step has `ERROR` in the result — engine stopped there               | Enter §10.2        |
| **Silent misfire**     | All steps completed but final screenshot shows wrong screen           | Enter §10.2        |
| **Partial divergence** | Intermediate screenshot shows wrong state even though later steps ran | Enter §10.2        |

For silent misfires and partial divergence, echo annotations (§10.5) are your reference for what each screen _should_ look like.

### 10.2 Diagnose

1. Note the failure step index and error message (if hard error).
2. Call `screenshot` to see where the app actually is now.
3. Call `describe` or `debugger-component-tree` to get the current element tree.
4. Compare current state to what the failed step expected. Classify the root cause:

| Root cause       | Symptoms                                                        |
| ---------------- | --------------------------------------------------------------- |
| Coordinate drift | Tap succeeded but hit wrong element; elements shifted positions |
| Missing element  | Target element not present in element tree                      |
| Wrong screen     | Screenshot shows entirely different page than expected          |
| Timing           | Element exists in tree but tap missed; loading spinner visible  |
| State mismatch   | First step fails — executionPrerequisite was not actually met   |

5. State the diagnosis in one sentence before attempting any correction.

### 10.3 Correct

Choose the lightest strategy that fits:

**Strategy 1 — Edit the YAML** (coordinate drift, parameter changes).
Read `.argent/flows/<flow-name>.yaml`, update the broken step's `x`/`y`, `bundleId`, `text`, or other args. Re-run `flow-execute` to verify.

**Strategy 2 — Manual recovery + continue** (timing/transient issues, one-off replay).
Manually execute the failed step with corrected coordinates from §10.2 discovery, then manually execute remaining steps. Does not fix the YAML — use only when re-recording is not worth it.

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

### 10.4 Verify and Bound Retries

After applying a correction, re-run `flow-execute` to verify.

- If it succeeds → done. Report what changed (e.g. "Fixed step 4: updated tap coordinates from 0.5,0.35 to 0.5,0.42").
- If it fails at a **different** step → return to §10.2 for a second attempt.
- If this is already the second correction attempt → **stop**. Report the diagnosis to the user and recommend a full re-record or manual investigation.

**Hard cap: 2 correction cycles.** Do not enter an unbounded fix loop.

### 10.5 Making Flows Resilient

Apply these when recording new flows to reduce future breakage:

- **Echo expected state, not just actions.** Write `"On Settings > General screen, about to tap About"` not `"Tap About"`. During diagnosis these tell you what the screen _should_ look like.
- **Gate transitions with `await-ui-element`, not fixed delays.** After a tap that triggers a navigation, record an `await-ui-element` step that waits for the next screen's element to be `visible` (or a spinner to be `hidden`) before the following step. This removes the **Timing** failure mode in §10.2 (the element is in the tree but the tap fired before the screen settled) and is more reliable than `delayMs` or an extra `screenshot`. An unmet wait stops replay at that step, so a mistimed step can never run blind.
- **Add screenshot steps after critical navigation.** Insert `screenshot` steps after screen transitions. These produce images in the flow result you can inspect during diagnosis.
- **Write specific executionPrerequisites.** `"App on home tab, user logged in, simulator UDID is <X>"` — not `"App running"`. Verify with `screenshot` + `describe` before acknowledging.
- **Prefer launch-app / open-url over navigation chains.** Deep links are more resilient to layout changes than tap sequences.
- **Echo accessibility labels for coordinate taps.** When recording a tap, add an echo with the target's label or testID: `"Tapping 'Submit' button (testID: submit-btn) at 0.5, 0.82"`. During repair, use `describe` to find the element by label and update coordinates. Only use `screenshot` for permission or system overlays when `describe` cannot expose the target reliably.
