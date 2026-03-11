---
name: simulator-interact
description: Interact with a running iOS simulator using argent MCP tools. Use when tapping UI elements, scrolling, typing text, pressing hardware buttons, launching apps, opening URLs, or performing any gesture on the simulator.
---

## 1. Before You Start

All simulator interactions go through argent MCP tools — DO NOT use `Bash`, `curl`, or the `simulator-server` binary directly. If you delegate simulator tasks to sub-agents - make sure they have  MCP permissions.

Use `list-simulators` to find available simulators. **Pick the first result** — booted iPhones are listed first. If none are booted, use `boot-simulator` first.

## 2. Opening Apps

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

## 3. Choosing the Right Tool

| Action           | Tool         | Notes                                          |
| ---------------- | ------------ | ---------------------------------------------- |
| Open an app      | `launch-app` | **Always — never tap home-screen icons**       |
| Restart an app   | `restart-app`| Reinstall or reconnect to Metro                |
| Open URL/scheme  | `open-url`   | Web pages, deep links, URL schemes             |
| Single tap       | `tap`        | Buttons, links, checkboxes                     |
| Scroll/swipe     | `swipe`      | Straight-line scroll or swipe                  |
| Long press       | `gesture`    | Context menus, drag start                      |
| Drag & drop      | `gesture`    | Complex drag interactions                      |
| Pinch/zoom       | `gesture`    | Two-finger gestures                            |
| Hardware key     | `button`     | Home, back, power, volume                      |
| Type text (fast) | `paste`      | Form fields — uses clipboard                   |
| Type text        | `keyboard`   | Fallback when paste fails; supports Enter, Escape, arrows |
| Rotate device    | `rotate`     | Orientation changes                            |

## 4. Tool Usage

### tap — Single tap at a point
```json
{ "udid": "<UDID>", "x": 0.5, "y": 0.5 }
```
Coordinates: `0.0` = left/top, `1.0` = right/bottom.

Before tapping near the bottom of the screen in React Native apps, check that "Open Debugger to View Warnings" banners are not visible — tapping them breaks the debugger connection. Close them with the X icon if present.

### swipe — Straight-line gesture
```json
{ "udid": "<UDID>", "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 }
```
Swipe **up** (`fromY > toY`) = scroll content **down**. Optional: `"durationMs": 500` for slower swipe.

### gesture — Custom touch sequence

For long-press, pinch, and drag-and-drop sequences, see `references/gesture-examples.md`.

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

## 5. Screenshots

Interaction tools (`tap`, `swipe`, `gesture`, `button`, `keyboard`, `rotate`, `launch-app`, `restart-app`, `open-url`, `describe`) **automatically attach a screenshot**. No separate `screenshot` call needed.

Use the explicit `screenshot` tool only when:
- You need the initial screen state before any action.
- The auto-attached screenshot shows a transitional or loading frame.
- You require extra context

---

## Best Practices

1. **Start every task with `launch-app` or `open-url`.**
2. **Use `swipe` for lists/scrolling**, not `gesture`, unless you need non-linear movement.
3. **Tap a text field before typing** — try `paste` first, fall back to `keyboard`.
4. **Wait for animations** — give the app ~300ms after `tap` or `button` before the next action.
5. **Coordinates are normalized** — always 0.0–1.0, not pixels.

## Related Skills

| Skill                  | When to use                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `simulator-setup`      | Booting and connecting a simulator                           |
| `simulator-screenshot` | Capturing screenshots without an interaction                 |
| `react-native-app-workflow` | Starting the app, Metro, build issues                        |
| `metro-debugger`       | Breakpoints, stepping, console logs, JS evaluation           |
| `test-ui-flow`         | Interactive UI testing with screenshot verification          |
