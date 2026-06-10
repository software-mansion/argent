---
name: argent-tvos-interact
description: Interact with an Apple TV simulator using argent MCP tools. Use when navigating tvOS UI, moving focus with the Siri remote, activating elements, typing text into search fields, or reading the accessibility state of a tvOS simulator.
---

## The tvOS interaction model

tvOS is **focus-driven** — there are no tap coordinates. The Siri remote moves a focus highlight between on-screen elements; the focused element is activated with `select`. The entire interaction loop is:

1. `tv-describe` — see what is currently focused and what is focusable.
2. `tv-navigate` or `tv-set-focus` — move focus to the target.
3. `tv-describe` again — confirm where focus landed.
4. Once the target is focused, `tv-navigate` with `select` to activate it.

Do not use `gesture-tap`, `gesture-swipe`, `button`, `keyboard`, or any other iOS/Android interaction tool on tvOS. They do not apply.

---

## 1. Before You Start

If you delegate simulator tasks to sub-agents, make sure they have MCP permissions.

Call `list-devices` and pick a simulator with `runtimeKind: "tv"`. If none are booted, call `boot-device` first. See `argent-tvos-simulator-setup` for the full setup flow.

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
| Jump focus by label | `tv-set-focus` | Faster than D-pad traversal; requires knowing the label from `tv-describe` |
| Type text | `tv-type` | Focus a text field first, then call this |

---

## 3. Tool Usage

### tv-describe — Read focus state

```json
{ "udid": "<tvOS UDID>" }
```

Returns the currently focused element and all focusable elements on screen. Always call this before navigating (to see what is available) and after navigating (to confirm where focus landed).

Output includes `focusedLabel`, `focusableCount`, and a `description` text rendering of the full focus state.

### tv-navigate — Send a Siri-remote input

```json
{ "udid": "<tvOS UDID>", "direction": "right" }
```

Valid directions: `up`, `down`, `left`, `right`, `select`, `menu`, `home`, `playpause`.

Call `tv-describe` after navigating to see where focus landed.

Prefer `tv-navigate` over `tv-set-focus` when validating that a user can actually reach an element via the remote.

### tv-set-focus — Jump focus by accessibility label

```json
{ "udid": "<tvOS UDID>", "label": "Settings" }
```

Jumps focus directly to the element with the given label, skipping D-pad traversal. Use when you already know the target from `tv-describe` and don't need to validate the navigation path.

Returns `{ ok, message }`. `ok: false` means the label was not found in the current focusable set.

### tv-type — Type text into a focused field

```json
{ "udid": "<tvOS UDID>", "text": "search query" }
```

Types text via HID keyboard events into the currently focused text field. Focus the field first with `tv-navigate` or `tv-set-focus`, then call this. Uppercase and common symbols are handled automatically.

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
tvOS tools `tv-navigate`, `tv-set-focus`, and `tv-type` (the `gesture-*`
tools are iOS/Android-only and don't apply to tvOS). The `udid` is shared and
auto-injected — don't repeat it per step.

```json
{
  "udid": "<TVOS-UDID>",
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
| Tool fails with "not a tvOS simulator" | Passed an iOS UDID — use `list-devices` and pick a `runtimeKind: "tv"` entry |
| `tv-set-focus` returns `ok: false` | Label not in the current focusable set — call `tv-describe` first and use the exact label shown |
| Daemons take a few seconds on first call | Normal — `tvos-ax-service` and `tvos-hid-daemon` start on first use and stay running |
| Focus doesn't move as expected | Some tvOS screens throttle focus-engine changes; always call `tv-describe` after each step |

---

## Related Skills

| Skill | When to use |
|-------|-------------|
| `argent-tvos-simulator-setup` | Boot and connect to an Apple TV simulator before interacting |
| `argent-device-interact` | Tapping, swiping, gestures — iOS and Android (not tvOS) |
| `argent-ios-simulator-setup` | iOS simulator boot and connection setup |
