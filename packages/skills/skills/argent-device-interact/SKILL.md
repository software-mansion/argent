---
name: argent-device-interact
description: Interact with an iOS simulator, Android emulator, or Chromium (CDP) app using argent MCP tools. Use when tapping UI elements, performing gestures, scrolling/swiping, typing text, pressing hardware buttons, launching apps, opening URLs, taking screenshots, waiting for an element to appear or disappear, or checking visible app state after interactions. Not for TV targets.
---

Each tool's own description carries its parameters, defaults, return shape and examples. This skill covers choosing between tools and the gotchas those descriptions don't state.

## 1. Before You Start

- Get a target id from `list-devices`; if none is ready, `boot-device` one. Full setup flow: `argent-ios-simulator-setup` / `argent-android-emulator-setup`. The same tool names drive iOS, Android and Chromium; each takes the `udid` from `list-devices`.
- Read the matching reference before driving these targets: `references/chromium.md` for a `chromium` target, `references/harmonyos.md` for a `harmony` target, `references/foldables.md` for a device `list-devices` marks `foldable: true` (or before calling `fold`).
- Tools that are not loaded upfront (e.g. `gesture-pinch`, `gesture-rotate`, `gesture-custom`) may be deferred: load their schema with ToolSearch before the first call, or numeric parameters can be sent as strings and fail validation.
- If you delegate device tasks to sub-agents, make sure they have MCP permissions.

## 2. Choosing the Right Tool

| Action                         | Tool                | Notes                                                          |
| ------------------------------ | ------------------- | -------------------------------------------------------------- |
| Several known steps            | `run-sequence`      | One call, one screenshot at the end (§5)                       |
| Open an app                    | `launch-app`        | **Never tap home-screen icons**                                |
| Restart an app                 | `restart-app`       | Clean in-memory state                                          |
| Open URL / deep link           | `open-url`          | Web pages, deep links, URL schemes                             |
| Tap                            | `gesture-tap`       | Buttons, links, checkboxes                                     |
| Scroll / swipe                 | `gesture-swipe`     | Touch targets; not Chromium                                    |
| Scroll (Chromium)              | `gesture-scroll`    | Mouse wheel                                                    |
| Drag (Chromium)                | `gesture-drag`      | Sliders, drag-and-drop, text selection                         |
| Long press, drag & drop        | `gesture-custom`    | Also any other non-linear touch sequence                       |
| Pinch / zoom                   | `gesture-pinch`     |                                                                |
| Two-finger rotation            | `gesture-rotate`    |                                                                |
| Hardware key                   | `button`            | Home, back, power, volume, appSwitch, actionButton             |
| Type text or press a named key | `keyboard`          | Every platform; text or one key per call (§6)                  |
| Paste text                     | `paste`             | Only where a user would paste (§6). Sim/emu only               |
| Rotate device                  | `rotate`            | Orientation changes                                            |
| Fold device                    | `fold`              | Foldables only: `references/foldables.md`                      |
| Shake device                   | `shake`             | Shake handlers (sim/emu only), Undo-typing prompt, RN dev menu |
| Wait for UI                    | `await-ui-element`  | Block until an element is visible/hidden/exists/contains text  |
| Wait for idle                  | `await-screen-idle` | Block until a non-empty screen tree stops changing (§4)        |

## 3. Finding Tap Targets

After an action moves you to a different screen, or whenever you don't know an element's coordinates, discover before tapping. Interaction results already carry the element tree (`--- Elements after action (describe) ---`): use it, and call a discovery tool only when no fresh tree covers the current screen.

| Need                                           | Tool                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Any screen: app, system dialog, Home screen    | `describe`                                                                                                                     |
| React Native component names, testIDs          | `debugger-component-tree`                                                                                                      |
| App-scoped UIKit properties (iOS simulator)    | `native-describe-screen` (needs `bundleId`)                                                                                    |
| What sits at a known raw point (iOS simulator) | `native-user-interactable-view-at-point` (the view that receives touch) or `native-view-at-point` (the visually deepest view)  |
| Final visual fallback                          | `screenshot`, only when the tools above cannot expose the control. Do not derive routine in-app navigation targets from pixels |

If `describe` fails, act on the error:

- `ax-service` not available, or daemon startup failure: check that the simulator is booted. Meanwhile use `screenshot`, or `native-describe-screen` if the app has native devtools injected.
- Empty element list: the screen may be blank, loading, or unlabeled. Check with `screenshot`, then retry once the content has loaded.
- Not detailed enough for a React Native app: use `debugger-component-tree`.

**React Native:** before tapping near the bottom of the screen, close any "Open Debugger to View Warnings" banner with its X. Tapping the banner itself breaks the debugger connection.

**System and permission dialogs:** `describe` returns a visible dialog's buttons with tap coordinates; keep using it for in-app modals too. Fall back to `screenshot` only if it does not expose the controls: then tap one obvious button (`Allow`, `OK`, `Don't Allow`, `Not Now`, `Continue`) at a time, check the returned screenshot, and go back to `describe` once the dialog is gone.

> **Prefer the dialog over the Settings tool.** When the app triggers its own permission prompt, answering it is the real user path. Use `settings-permissions` only when you can't make the change through the app: set a permission _before_ the app asks, re-enable one the user denied (iOS won't re-prompt), or reset it so the prompt reappears. See `argent-settings-permissions`.

## 4. Waiting: `await-ui-element` and `await-screen-idle`

**Never poll `screenshot`/`describe` in a loop to wait for something.** `await-ui-element` blocks server-side on the same tree `describe` reads. It has no bare-timer mode; for a plain pause, use your own harness sleep. Its description covers conditions, selector matching and defaults. What it does not tell you:

- A `hidden` check that succeeds **immediately** may be a false pass: its `note` then says the selector never matched anything. Treat that as a failed check and fix the selector; it does not mean "the element went away".
- The synthetic `ROOT` container `describe` prints is never matched, so a `role` like `AXGroup`/`html` won't trivially "match the screen".
- To disambiguate a loose selector, pin `role` to a text role like `StaticText`; that skips a same-named button.

`await-screen-idle` is for live diagnosis after a launch or navigation, before a raw tap on an element that may still be moving. Continue only when `settled: true`, and pair it with an `await-ui-element` for the destination: stillness does not identify a screen, and the tool can return during a presentation-layer animation. Do not record it in an e2e test; tests use `await: { idle: true }`, which also compares pixels.

## 5. Action Sequencing with `run-sequence`

Use `run-sequence` when every step is known in advance; if a step depends on what the previous one shows, use separate calls. Its description lists the allowed tools and their arguments. Typical batches:

- "scroll to bottom", "scroll until X": 3-5 swipes
- "clear and retype a field": triple-tap to select all, then type the new value
- typing then submitting: a `keyboard` text step, then a `keyboard` `enter` step (one call cannot carry both)
- "submit form": fill every field, then tap submit
- "go back to X": a known tap path

Gate a step that depends on a screen transition with an `await-ui-element` step rather than a fixed `delayMs`. If its condition is not met before the timeout, the sequence **stops there** and the later steps do not run, so a tap can't fire against a screen that never appeared. Any failing step also stops the sequence, with partial results.

## 6. Text Entry and Secrets

- Tap the field first. Typing or pasting with no focused field is a silent no-op.
- **React Native: the first tap after typing may only close the keyboard.** Inside a scroll view with the default `keyboardShouldPersistTaps="never"`, React Native uses a tap outside the focused field to dismiss the keyboard and does not pass it on (with `"handled"` or `"always"` the tap reaches the button), so a button tapped right after typing may need a second tap; check the returned tree. When the field submits on return, `{ "key": "enter" }` avoids the extra tap.
- `paste` is **not** a faster `keyboard`. `keyboard` types the way a user types and stays the default for every text entry. Use `paste` only where a real user would paste: a 2FA / OTP code from another app, a long link or token, or testing how the app handles pasted input. That it can carry text `keyboard` can't type on a platform (multi-line text, non-ASCII on Android) is not a reason on its own.
- **Credentials:** put a `{{secret:<NAME>}}` placeholder in `text` (`keyboard`, `paste`, `run-sequence` keyboard steps, e2e `type` steps). `keyboard`'s description lists where the value is read from. Then:
  - Do **not** `describe` or `screenshot` a non-secure field you just filled with a secret: submit or navigate away first, then verify the resulting screen. Keep the text step and the `enter` step in **one `run-sequence`**; a second bare `keyboard` call gets its own screenshot of the filled field.
  - An unknown name fails with the available names and every source it looked in; read that before asking the user anything. Never ask for the value in the conversation: ask the user to add it to a secrets file. Project files are found by walking up from the tool-server's working directory; `~/.argent/secrets.env` always applies.

## 7. Screenshots

Interaction tools already attach a screenshot. Call `screenshot` for the initial state, for a baseline before you change visible UI, to check state after a delay, or when the attached capture shows a transitional or loading frame.

Keep the default downscaled capture for UI context and state checks; do not use `scale: 1.0` as a readability or tapping aid. Full resolution is only for saving baseline/current PNGs for comparison (`scale: 1.0` with `includeImageInContext: false`); for visual regression checks use the `argent-screenshot-diff` skill.

If `screenshot` times out, restart the device transport with `stop-simulator-server`.

## 8. Android notes

- **Metro reachability**: run `adb reverse tcp:8081 tcp:8081` before the RN app starts, or Metro won't be reachable from the device. Re-run it if the device restarts. See `argent-metro-debugger`.
- **First-launch permission prompts**: `reinstall-app` on Android installs with `-g`, so runtime permissions are pre-granted on first launch.
