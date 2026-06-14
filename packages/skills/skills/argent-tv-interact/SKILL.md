---
name: argent-tv-interact
description: Interact with a TV device (Apple TV / tvOS simulator or Android TV / leanback device) using argent MCP tools. Use when navigating TV UI, moving focus with the remote / D-pad, activating elements, typing text into search fields, or reading the focus state of a TV target.
---

## The TV interaction model

A TV UI — Apple TV (tvOS) or Android TV (leanback) — is **focus-driven**: there are no tap coordinates. The remote / D-pad moves a focus highlight between on-screen elements; the focused element is activated with `select`. The same `tv-*` tools drive both platforms — the backend differs (injected Siri-remote HID on Apple TV, `adb` keyevents on Android TV) but the tool surface is identical. The entire interaction loop is:

1. `tv-describe` — see what is currently focused and what is focusable.
2. `tv-navigate` or `tv-set-focus` — move focus to the target.
3. `tv-describe` again — confirm where focus landed.
4. Once the target is focused, `tv-navigate` with `select` to activate it.

Do not use `gesture-tap`, `gesture-swipe`, `button`, `keyboard`, or any other coordinate/touch interaction tool on a TV target. They do not apply.

---

## 1. Before You Start

If you delegate device tasks to sub-agents, make sure they have MCP permissions.

Call `list-devices` and pick a device with `runtimeKind: "tv"` — an Apple TV simulator (iOS UDID shape) or an Android TV serial. If none are booted, call `boot-device` first. See `argent-tv-setup` for the full setup flow.

---

## 2. Choosing the Right Tool

| Action | Tool | Notes |
|--------|------|-------|
| Read focus state | `tv-describe` | Use before and after every navigation step |
| Move focus | `tv-navigate` | D-pad: `up/down/left/right`; use when validating real nav paths |
| Activate element | `tv-navigate` with `select` | Equivalent to a tap on iOS |
| Go back | `tv-navigate` with `menu` | Back one level |
| Exit to home | `tv-navigate` with `home` | Exits the current app |
| Toggle playback | `tv-navigate` with `playpause` | Media apps |
| Move focus by label | `tv-set-focus` | Apple TV jumps directly; Android TV walks the D-pad toward the target (best-effort). Requires knowing the label from `tv-describe` |
| Type text | `tv-type` | Focus a text field first, then call this |

---

## 3. Tool Usage

### tv-describe — Read focus state

```json
{ "udid": "<TV target id>" }
```

Returns the currently focused element and all focusable elements on screen. Always call this before navigating (to see what is available) and after navigating (to confirm where focus landed).

Output includes `focusedLabel`, `focusableCount`, and a `description` text rendering of the full focus state.

> **Android TV: some screens legitimately report `focusableCount: 0`.** Android TV reads focus from the OS accessibility tree (`uiautomator`). Many `react-native-tvos` screens manage focus with React Native's *own* focus engine, which Android's accessibility tree does not expose — so `tv-describe` can correctly return zero focusables on a screen that visibly has selectable tiles (e.g. a full-screen RN promo/upsell). This is faithful reporting, not a tool failure. When it happens: (1) take a `screenshot` to see what's actually there, (2) use the full `describe` tool instead — it surfaces the `content-desc`/`text` tree the RN screen does expose, and (3) `tv-navigate` still moves focus on these screens even though the labels aren't enumerable, so you can drive blind + screenshot to confirm. Screens that use native focusable views (the NFL sidebar, system dialogs) report focusables normally.

### tv-navigate — Send a Siri-remote input

```json
{ "udid": "<TV target id>", "direction": "right" }
```

Valid directions: `up`, `down`, `left`, `right`, `select`, `menu`, `home`, `playpause`.

Call `tv-describe` after navigating to see where focus landed.

Prefer `tv-navigate` over `tv-set-focus` when validating that a user can actually reach an element via the remote.

### tv-set-focus — Move focus by accessibility label

```json
{ "udid": "<TV target id>", "label": "Settings" }
```

Moves focus to the element with the given label. On Apple TV this jumps directly; on Android TV (no jump primitive) it walks the D-pad toward the target's on-screen position — best-effort and bounded. Use when you already know the target from `tv-describe` and don't need to validate the exact navigation path.

Returns `{ ok, message }`. `ok: false` means the label was not on screen, or (Android TV) focus couldn't reach it by D-pad — fall back to step-by-step `tv-navigate`.

### tv-type — Type text into a focused field

```json
{ "udid": "<TV target id>", "text": "search query" }
```

Types text into the currently focused text field (injected HID keyboard on Apple TV, `adb input text` on Android TV). Focus the field first with `tv-navigate` or `tv-set-focus`, then call this. Uppercase and common symbols are handled automatically.

> `tv-type` reports `{ typed }` on success **whether or not a field actually received the text** — it can't see where the keystrokes land. If the target field must hold focus first, confirm the text arrived with a follow-up `tv-describe`/`screenshot` rather than trusting the return value. A common miss on Android TV is typing into a field that hasn't gained focus yet (e.g. a still-loading screen): the call "succeeds" but the field stays empty — re-focus and retry.

---

## 4. Common Workflows

### Navigate to and activate an element

```
tv-describe                           → see what is focused and what is focusable
tv-navigate { direction: "down" }     → move focus
tv-describe                           → confirm where focus landed
tv-navigate { direction: "select" }   → activate the focused element
```

### Type into a search field

```
tv-describe                           → confirm a text field is focused
tv-type { text: "Planet Earth" }      → type the query
tv-navigate { direction: "select" }   → submit
```

### Go back or exit

```
tv-navigate { direction: "menu" }     → back one level
tv-navigate { direction: "home" }     → exit to the tvOS home screen
```

---

## 5. Batching Known Paths with `run-sequence`

When a navigation path is known in advance and you don't need to inspect the
screen between steps, batch it in a single `run-sequence` call. It accepts the
TV tools `tv-navigate`, `tv-set-focus`, and `tv-type` (the `gesture-*` tools
are touch-only and don't apply to a TV target). The `udid` is shared and
auto-injected — don't repeat it per step.

```json
{
  "udid": "<TV target id>",
  "steps": [
    { "tool": "tv-navigate", "args": { "direction": "right" } },
    { "tool": "tv-navigate", "args": { "direction": "right" } },
    { "tool": "tv-navigate", "args": { "direction": "select" } }
  ]
}
```

Only use this when every step is known up front. If a step depends on where
focus actually landed, call `tv-describe` between individual `tv-navigate`
calls instead — `run-sequence` captures no screenshot and does no inspection
between steps.

---

## 6. Troubleshooting

| Problem | Solution |
|---------|----------|
| Tool fails with "not a tvOS simulator" / "Android-TV-only" | Passed a non-TV target — use `list-devices` and pick a `runtimeKind: "tv"` entry |
| `tv-set-focus` returns `ok: false` | Label not on screen (call `tv-describe` and use the exact label shown), or on Android TV focus couldn't reach it by D-pad — fall back to step-by-step `tv-navigate` |
| Apple TV daemons take a few seconds on first call | Normal — `tvos-ax-service` and `tvos-hid-daemon` start on first use and stay running |
| Focus doesn't move as expected | Some TV screens throttle focus changes; always call `tv-describe` after each step |
| **Android TV:** `tv-describe` shows `focusableCount: 0` on a screen that clearly has tiles | Expected on `react-native-tvos` screens that use RN's own focus engine (invisible to the OS accessibility tree). Use `screenshot` + the full `describe` tool; `tv-navigate` still moves focus, so drive + screenshot to confirm. Not a bug. |
| **Android TV:** right after `launch-app`/`restart-app`, `tv-describe` is empty | The RN bundle is still loading (splash window). Wait ~2–3s and retry — `tv-describe` retries internally, but a cold dev-client start can take longer. |
| `debugger-*` / profiler tools target the wrong app when two devices share one Metro | The CDP page is chosen by **recency of the last registered WebSocket**, not by `device_id` — `device_id` only resolves the session-cache key. If a tvOS and an Android (or phone) app are both connected to one Metro, the most-recently-foregrounded one wins. Bring the target app to the foreground (or background the other, e.g. a HOME intent) so it re-registers as the most-recent page, then connect. |

---

## Related Skills

| Skill | When to use |
|-------|-------------|
| `argent-tv-setup` | Boot and connect to a TV target (Apple TV simulator or Android TV emulator) before interacting |
| `argent-android-emulator-setup` | Boot and connect to an Android emulator / Android TV AVD before interacting |
| `argent-device-interact` | Tapping, swiping, gestures — phone/tablet iOS and Android (not TV) |
| `argent-ios-simulator-setup` | iOS simulator boot and connection setup |
