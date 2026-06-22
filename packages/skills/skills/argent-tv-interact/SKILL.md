---
name: argent-tv-interact
description: Interact with a TV device (Apple TV / tvOS simulator or Android TV / leanback device) using argent MCP tools. Use when navigating TV UI, moving focus with the remote / D-pad, activating elements, typing text into search fields, or reading the focus state of a TV target.
---

## The TV interaction model

A TV UI — Apple TV (tvOS) or Android TV (leanback) — is **focus-driven**: there are no tap coordinates. The remote / D-pad moves a focus highlight between on-screen elements; the focused element is activated with `select`. The same tools drive both platforms — the backend differs (injected Siri-remote HID on Apple TV, `adb` keyevents on Android TV) but the tool surface is identical. TV interaction reuses the standard cross-platform tools, which detect a `runtimeKind: "tv"` target and route to the focus-driven backend:

- **`describe`** — read the focus state (focused + focusable elements) instead of a tap tree.
- **`button`** — press a remote button: `up`/`down`/`left`/`right` move focus, `select` activates, `menu` goes back, `home` exits, `playpause` toggles media.
- **`keyboard`** — type text into the focused field (the `key` named-key arg does not apply on TV; use `button` arrows to move focus).
- **`tv-set-focus`** — jump focus directly to an element by its accessibility label (the one TV-specific tool, with no phone/tablet analog).

The entire interaction loop is:

1. `describe` — see what is currently focused and what is focusable.
2. `button` (a direction) or `tv-set-focus` — move focus to the target.
3. `describe` again — confirm where focus landed.
4. Once the target is focused, `button` with `select` to activate it.

Do not use `gesture-tap`, `gesture-swipe`, or any other coordinate/touch interaction tool on a TV target. They do not apply.

---

## 1. Before You Start

If you delegate device tasks to sub-agents, make sure they have MCP permissions.

Call `list-devices` and pick a device with `runtimeKind: "tv"` — an Apple TV simulator (iOS UDID shape) or an Android TV serial. If none are booted, call `boot-device` first. See `argent-tv-setup` for the full setup flow.

---

## 2. Choosing the Right Tool

| Action              | Tool                      | Notes                                                                                                                           |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Read focus state    | `describe`                | Use before and after every navigation step                                                                                      |
| Move focus          | `button` with a direction | D-pad: `up/down/left/right`; use when validating real nav paths                                                                 |
| Activate element    | `button` with `select`    | Equivalent to a tap on iOS                                                                                                      |
| Go back             | `button` with `menu`      | Back one level                                                                                                                  |
| Exit to home        | `button` with `home`      | Exits the current app                                                                                                           |
| Toggle playback     | `button` with `playpause` | Media apps                                                                                                                      |
| Move focus by label | `tv-set-focus`            | Apple TV jumps directly; Android TV walks the D-pad toward the target (best-effort). Requires knowing the label from `describe` |
| Type text           | `keyboard` with `text`    | Focus a text field first, then call this                                                                                        |

---

## 3. Tool Usage

### describe — Read focus state

```json
{ "udid": "<TV target id>" }
```

On a TV target, `describe` returns the focus-driven view: the currently focused element and all focusable elements on screen (not a tap tree). Always call it before navigating (to see what is available) and after navigating (to confirm where focus landed). The text rendering marks the focused element with `→` and shows each focusable element's label, value, and traits.

> **Android TV: some screens legitimately report no focusable elements.** Android TV reads focus from the OS accessibility tree (`uiautomator`). Many `react-native-tvos` screens manage focus with React Native's _own_ focus engine, which Android's accessibility tree does not expose — so `describe` can correctly find zero focusables on a screen that visibly has selectable tiles (e.g. a full-screen RN promo/upsell). When this happens `describe` **automatically falls back to the full UI tree** (the same `content-desc`/`text` tree a phone `describe` returns) and notes it in the `hint`, so you still get a usable rendering. `button` (a direction / `select`) still moves focus on these screens even though the labels aren't enumerable, so you can drive blind + `screenshot` to confirm. Screens that use native focusable views (the NFL sidebar, system dialogs) report focusables normally.

### button — Send a remote / D-pad input

```json
{ "udid": "<TV target id>", "button": "right" }
```

Valid TV buttons: `up`, `down`, `left`, `right`, `select`, `menu`, `home`, `playpause`.

Call `describe` after pressing to see where focus landed.

Prefer stepping with `button` directions over `tv-set-focus` when validating that a user can actually reach an element via the remote.

### tv-set-focus — Move focus by accessibility label

```json
{ "udid": "<TV target id>", "label": "Settings" }
```

Moves focus to the element with the given label. On Apple TV this jumps directly; on Android TV (no jump primitive) it walks the D-pad toward the target's on-screen position — best-effort and bounded. Use when you already know the target from `describe` and don't need to validate the exact navigation path.

Returns `{ ok, message }`. `ok: false` means the label was not on screen, or (Android TV) focus couldn't reach it by D-pad — fall back to step-by-step `button` presses.

### keyboard — Type text into a focused field

```json
{ "udid": "<TV target id>", "text": "search query" }
```

Types text into the currently focused text field (injected HID keyboard on Apple TV, `adb input text` on Android TV). Focus the field first with `button` or `tv-set-focus`, then call this. Uppercase and common symbols are handled automatically. The `key` (named-key) argument is not supported on a TV target — move focus with `button` arrows instead.

> `keyboard` reports success **whether or not a field actually received the text** — it can't see where the keystrokes land. If the target field must hold focus first, confirm the text arrived with a follow-up `describe`/`screenshot` rather than trusting the return value. A common miss on Android TV is typing into a field that hasn't gained focus yet (e.g. a still-loading screen): the call "succeeds" but the field stays empty — re-focus and retry.

---

## 4. Common Workflows

### Navigate to and activate an element

```
describe                          → see what is focused and what is focusable
button { button: "down" }         → move focus
describe                          → confirm where focus landed
button { button: "select" }       → activate the focused element
```

### Type into a search field

```
describe                          → confirm a text field is focused
keyboard { text: "Planet Earth" } → type the query
button { button: "select" }       → submit
```

### Go back or exit

```
button { button: "menu" }         → back one level
button { button: "home" }         → exit to the tvOS home screen
```

---

## 5. Batching Known Paths with `run-sequence`

When a navigation path is known in advance and you don't need to inspect the
screen between steps, batch it in a single `run-sequence` call. On a TV target
it accepts `button` (remote presses), `keyboard` (text), and `tv-set-focus`
(the `gesture-*` tools are touch-only and don't apply). The `udid` is shared
and auto-injected — don't repeat it per step.

```json
{
  "udid": "<TV target id>",
  "steps": [
    { "tool": "button", "args": { "button": "right" } },
    { "tool": "button", "args": { "button": "right" } },
    { "tool": "button", "args": { "button": "select" } }
  ]
}
```

Only use this when every step is known up front. If a step depends on where
focus actually landed, call `describe` between individual `button`
calls instead — `run-sequence` captures no screenshot and does no inspection
between steps.

---

## 6. Troubleshooting

| Problem                                                                                   | Solution                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool fails with "not a tvOS simulator" / "Android-TV-only"                                | Passed a non-TV target — use `list-devices` and pick a `runtimeKind: "tv"` entry                                                                                                                                                                                                                                                                                                                               |
| `tv-set-focus` returns `ok: false`                                                        | Label not on screen (call `describe` and use the exact label shown), or on Android TV focus couldn't reach it by D-pad — fall back to step-by-step `button` presses                                                                                                                                                                                                                                            |
| `button` rejects a TV button (e.g. "not a TV remote button") on a phone, or vice versa    | The button set is per-target: phones take hardware buttons (home/back/power/volume…), TV targets take remote buttons (up/down/left/right/select/menu/home/playpause). Check `list-devices` `runtimeKind`                                                                                                                                                                                                       |
| Apple TV daemons take a few seconds on first call                                         | Normal — `tvos-ax-service` and `tvos-hid-daemon` start on first use and stay running                                                                                                                                                                                                                                                                                                                           |
| Focus doesn't move as expected                                                            | Some TV screens throttle focus changes; always call `describe` after each step                                                                                                                                                                                                                                                                                                                                 |
| **Android TV:** `describe` shows no focusable elements on a screen that clearly has tiles | Expected on `react-native-tvos` screens that use RN's own focus engine (invisible to the OS accessibility tree). `describe` auto-falls-back to the full UI tree; `button` still moves focus, so drive + screenshot to confirm. Not a bug.                                                                                                                                                                      |
| **Android TV:** right after `launch-app`/`restart-app`, `describe` focus is empty         | The RN bundle is still loading (splash window). Wait ~2–3s and retry — `describe` retries the focus read internally, but a cold dev-client start can take longer.                                                                                                                                                                                                                                              |
| `debugger-*` / profiler tools target the wrong app when two devices share one Metro       | The CDP page is chosen by **recency of the last registered WebSocket**, not by `device_id` — `device_id` only resolves the session-cache key. If a tvOS and an Android (or phone) app are both connected to one Metro, the most-recently-foregrounded one wins. Bring the target app to the foreground (or background the other, e.g. a HOME intent) so it re-registers as the most-recent page, then connect. |

---

## Related Skills

| Skill                           | When to use                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `argent-tv-setup`               | Boot and connect to a TV target (Apple TV simulator or Android TV emulator) before interacting |
| `argent-android-emulator-setup` | Boot and connect to an Android emulator / Android TV AVD before interacting                    |
| `argent-device-interact`        | Tapping, swiping, gestures — phone/tablet iOS and Android (not TV)                             |
| `argent-ios-simulator-setup`    | iOS simulator boot and connection setup                                                        |
