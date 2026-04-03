---
name: argent-simulator-interact
description: Interact with a running iOS simulator using argent MCP tools. Use when tapping UI elements, scrolling, typing text, pressing hardware buttons, launching apps, opening URLs, taking screenshots, or performing any gesture on the simulator.
---

## 1. Before You Start

If you delegate simulator tasks to sub-agents, make sure they have MCP permissions.

Use `list-simulators` to find available simulators. **Pick the first result** if specific not specified by user — booted iPhones are listed first. If none are booted, use `boot-simulator` first.

**Load tool schemas before first use.** Gesture tools (`gesture-tap`, `gesture-swipe`, `gesture-pinch`, `gesture-rotate`, `gesture-custom`) may be deferred — their parameter schemas are not loaded until fetched. Always use ToolSearch to load the schemas of all gesture tools you plan to use **before** calling any of them. If you skip this step, parameters may be coerced to strings instead of numbers, causing validation errors.

## 2. Best Practices

1. **Always refer to tapping_rule** from your argent.md rule before tapping.
2. Before performing interactions, consider whether they can be **dispatched sequentially** - more on that in `run-sequence`.
3. **Use `gesture-swipe` for lists/scrolling**, not `gesture-custom`, unless you need non-linear movement. Consider whether you need multiple swipes, if yes - use `run-sequence`.
4. **Tap a text field before typing** — try `paste` first, fall back to `keyboard`.
5. **Coordinates are normalized** — always 0.0–1.0, not pixels.

## 3. Opening Apps

**Never navigate to an app by tapping home-screen icons.** Use `launch-app` or `open-url` — they are instant and reliable.

### launch-app — by bundle ID

```json
{ "udid": "<UDID>", "bundleId": "com.apple.MobileSMS" }
```

Common IDs: `com.apple.MobileSMS` (Messages), `com.apple.mobilesafari` (Safari), `com.apple.Preferences` (Settings), `com.apple.Maps`, `com.apple.Photos`, `com.apple.mobilemail`, `com.apple.mobilenotes`, `com.apple.MobileAddressBook` (Contacts)

### open-url — by URL scheme

```json
{ "udid": "<UDID>", "url": "messages://" }
```

Common schemes: `messages://`, `settings://`, `maps://?q=<query>`, `tel://<number>`, `mailto:<address>`, `https://...` (Safari)

## 4. Choosing the Right Tool

| Action           | Tool             | Notes                                                     |
| ---------------- | ---------------- | --------------------------------------------------------- |
| Multiple actions | `run-sequence`   | Batch steps in one call (no intermediate screenshots)     |
| Open an app      | `launch-app`     | **Always — never tap home-screen icons**                  |
| Restart an app   | `restart-app`    | Reinstall or reconnect to Metro                           |
| Open URL/scheme  | `open-url`       | Web pages, deep links, URL schemes                        |
| Single tap       | `gesture-tap`    | Buttons, links, checkboxes                                |
| Scroll/swipe     | `gesture-swipe`  | Straight-line scroll or swipe                             |
| Long press       | `gesture-custom` | Context menus, drag start                                 |
| Drag & drop      | `gesture-custom` | Complex drag interactions                                 |
| Pinch/zoom       | `gesture-pinch`  | Two-finger pinch with auto-interpolation                  |
| Rotation         | `gesture-rotate` | Two-finger rotation with auto-interpolation               |
| Custom gesture   | `gesture-custom` | Arbitrary touch sequences, optional interpolation         |
| Hardware key     | `button`         | Home, back, power, volume                                 |
| Type text (fast) | `paste`          | Form fields — uses clipboard                              |
| Type text        | `keyboard`       | Fallback when paste fails; supports Enter, Escape, arrows |
| Rotate device    | `rotate`         | Orientation changes                                       |

## 5. Finding Tap Targets

IMPORTANT. When moved to a different screen after an action or do not know the coordinates of component, **always** perform proper discovery first.

| App type     | Discovery tool            | What it returns                                                                       |
| ------------ | ------------------------- | ------------------------------------------------------------------------------------- |
| Any iOS app  | `describe`                | iOS accessibility element tree with normalized frame coordinates                      |
| React Native | `debugger-component-tree` | React component tree with names, text, testID, and (tap: x,y)                         |
| Fallback     | `screenshot`              | when cannot determine using the above methods, use screenshot as a heuristic fallback |

## 6. Tool Usage

### gesture-tap — Single tap at a point

```json
{ "udid": "<UDID>", "x": 0.5, "y": 0.5 }
```

Coordinates: `0.0` = left/top, `1.0` = right/bottom.

Before tapping near the bottom of the screen in React Native apps, check that "Open Debugger to View Warnings" banners are not visible — tapping them breaks the debugger connection. Close them with the X icon if present.

### gesture-swipe — Straight-line gesture

```json
{ "udid": "<UDID>", "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 }
```

Swipe **up** (`fromY > toY`) = scroll content **down**. Optional: `"durationMs": 500` for slower swipe.

### gesture-pinch — Two-finger pinch

```json
{ "udid": "<UDID>", "centerX": 0.5, "centerY": 0.5, "startDistance": 0.2, "endDistance": 0.6 }
```

All values are normalized 0.0–1.0 (fractions of screen, not pixels) — same as all other gesture tools. `startDistance: 0.2` means fingers start 20% of the screen apart; `endDistance: 0.6` means they end 60% apart. `startDistance < endDistance` = pinch out (zoom in). `startDistance > endDistance` = pinch in (zoom out). Optional: `"angle": 90` for vertical axis, `"durationMs": 500` for slower pinch.

### gesture-rotate — Two-finger rotation

```json
{
  "udid": "<UDID>",
  "centerX": 0.5,
  "centerY": 0.5,
  "radius": 0.15,
  "startAngle": 0,
  "endAngle": 90
}
```

All positions and radius are normalized 0.0–1.0 (fractions of screen, not pixels). `radius: 0.15` means each finger is 15% of the screen away from center. `endAngle > startAngle` = clockwise. Optional: `"durationMs": 500` for slower rotation.

### gesture-custom — Custom touch sequence

For long-press, drag-and-drop, and other complex sequences, see `references/gesture-examples.md`. Set `"interpolate": 10` to auto-generate smooth intermediate Move events between keyframes.

### button — Hardware button press

```json
{ "udid": "<UDID>", "button": "home" }
```

Values: `home`, `back`, `power`, `volumeUp`, `volumeDown`, `appSwitch`, `actionButton`

### paste — Type text into focused field

```json
{ "udid": "<UDID>", "text": "Hello, world!" }
```

Tap the field first, then paste. Fall back to `keyboard` if it doesn't work.

### keyboard — Type text or press special keys

```json
{ "udid": "<UDID>", "text": "search query", "key": "enter" }
```

Special keys: `enter`, `escape`, `backspace`, `tab`, `space`, `arrow-up`, `arrow-down`, `arrow-left`, `arrow-right`, `f1`–`f12`

### rotate — Change orientation

```json
{ "udid": "<UDID>", "orientation": "LandscapeLeft" }
```

Values: `Portrait`, `LandscapeLeft`, `LandscapeRight`, `PortraitUpsideDown`

---

## 7. Screenshots

Use the explicit `screenshot` tool only when:

- You need the initial screen state before any action.
- The auto-attached screenshot shows a transitional or loading frame.
- You require extra context.
- You want to check state after a delay (e.g. waiting for a network response).

Optional rotation parameter: `{ "udid": "<UDID>", "rotation": "LandscapeLeft" }` — rotates the capture without changing simulator orientation.

Screenshots are downscaled by default (30% of original resolution) to reduce context size. If UI elements are hard to read or you need to inspect fine detail, pass `scale: 1.0` to get full resolution: `{ "udid": "<UDID>", "scale": 1.0 }`.

### Troubleshooting

| Problem              | Solution                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| Screenshot times out | Restart simulator-server via the `simulator-server` tool with a JWT token, then retry. |
| No booted simulator  | Run `boot-simulator` first.                                                            |

Note: Screenshots require a Pro/Team/Enterprise JWT token. The token only needs to be passed once — subsequent calls reuse the running process.

---

## 8. Action Sequencing with `run-sequence`

Use `run-sequence` to batch multiple interaction steps into **a single tool call**. Only one screenshot is returned — after all steps complete. Use cases:
scrolling multiple times, typing and submitting automatically, known sequence of multiple taps, rotating device back and forth.

Do **not** use `run-sequence` when any step depends on observing the result of a previous step

### Use cases

Use the sequencing when:

- Knowing that some action needs multiple steps without necessarily immediate insight of screenshot
- "scroll to bottom", "scroll to top", "scroll to do X" -> sequence scroll 3-5 times
- form interactions, "clear and retype field" -> you may use triple-tap to select all, type new value
- "submit form" → fill all fields in sequence, tap submit
- "go back to X" → defined tap sequence for the navigation

### Allowed tools inside `run-sequence`

`gesture-tap`, `gesture-swipe`, `gesture-custom`, `gesture-pinch`, `gesture-rotate`, `button`, `keyboard`, `rotate`

The `udid` is shared — do **not** include it in each step's `args`. Optional `delayMs` per step (default 100ms).

### Examples

Scroll down three times:

```json
{
  "udid": "<UDID>",
  "steps": [
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } },
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } },
    { "tool": "gesture-swipe", "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 } }
  ]
}
```

Type into a focused field and submit:

```json
{
  "udid": "<UDID>",
  "steps": [
    { "tool": "keyboard", "args": { "text": "hello world" } },
    { "tool": "keyboard", "args": { "key": "enter" } }
  ]
}
```

Tap a known button, then scroll down:

```json
{
  "udid": "<UDID>",
  "steps": [
    { "tool": "gesture-tap", "args": { "x": 0.5, "y": 0.15 } },
    {
      "tool": "gesture-swipe",
      "args": { "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 },
      "delayMs": 300
    }
  ]
}
```

Stops on the first error and returns partial results.
