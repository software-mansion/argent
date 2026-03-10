# Simulator Interaction

## ⚠️ Critical: MCP Tools Only

**ONLY use `mcp__radon-lite__*` MCP tools for all simulator interactions.**
- Never use `Bash`, `curl`, or direct HTTP calls to `http://localhost:3001`
- Never use the `simulator-server` binary directly
- Do NOT delegate simulator tasks to sub-agents — sub-agents may not have MCP tool permissions

## Choosing a Simulator

Use `list-simulators` to find available simulators. **Pick the first result** — the list is sorted with booted devices first, and iPhones before iPads.

- If a task doesn't specify a device type, prefer an already-booted iPhone
- If no simulator is booted, use `boot-simulator` with the desired UDID before proceeding

## Opening Apps — Always Do This First

**Never navigate to an app by tapping home-screen icons.** Use `launch-app` or `open-url` instead — they are instant and always reliable.

### launch-app — Open by bundle ID
```json
{ "udid": "<UDID>", "bundleId": "com.apple.MobileSMS" }
```
Common bundle IDs: `com.apple.MobileSMS` (Messages), `com.apple.mobilesafari` (Safari), `com.apple.Preferences` (Settings), `com.apple.Maps`, `com.apple.Photos`, `com.apple.mobilemail`, `com.apple.mobilenotes`, `com.apple.MobileAddressBook` (Contacts)

### open-url — Open via URL scheme
```json
{ "udid": "<UDID>", "url": "messages://" }
```
Common schemes: `messages://`, `settings://`, `maps://?q=<query>`, `tel://<number>`, `mailto:<address>`, `https://...` (opens in Safari)

## Choosing the Right Tool

| Action | Tool | When to use |
|--------|------|-------------|
| Open an app | `launch-app` | **Always — never tap home-screen icons** |
| Restart an app | `restart-app` | App reinstallation needed, reconnection to metro needed |
| Open a URL/scheme | `open-url` | Web pages, deep links, URL schemes |
| Single tap | `tap` | Buttons, links, checkboxes |
| Scroll/swipe | `swipe` | Straight-line scroll or swipe |
| Long press | `gesture` | Context menus, drag start |
| Drag & drop | `gesture` | Complex drag interactions |
| Pinch/zoom | `gesture` | Two-finger gestures |
| Hardware key | `button` | Home, back, power, volume |
| Type text | `paste` | Form fields (fastest, uses clipboard) |
| Type text | `keyboard` | When paste fails; supports Enter, Escape, arrows |
| Rotate device | `rotate` | Orientation changes |

## Tool Usage

### tap — Single tap at a point
```json
{ "udid": "<UDID>", "x": 0.5, "y": 0.5 }
```
Coordinates: `0.0` = left/top, `1.0` = right/bottom.

### swipe — Straight-line gesture
```json
{ "udid": "<UDID>", "fromX": 0.5, "fromY": 0.7, "toX": 0.5, "toY": 0.3 }
```
Swipe **up** (`fromY > toY`) to scroll content **down**.
Swipe **down** (`fromY < toY`) to scroll content **up**.
Optional: `"durationMs": 500` for a slower swipe.

### gesture — Custom touch sequence
```json
{
  "udid": "<UDID>",
  "events": [
    { "type": "Down", "x": 0.5, "y": 0.5 },
    { "type": "Up",   "x": 0.5, "y": 0.5, "delayMs": 800 }
  ]
}
```

**Long press** (800ms hold):
```json
[{"type":"Down","x":0.5,"y":0.5}, {"type":"Up","x":0.5,"y":0.5,"delayMs":800}]
```

**Pinch out** (zoom in):
```json
[
  {"type":"Down","x":0.4,"y":0.5,"x2":0.6,"y2":0.5},
  {"type":"Move","x":0.2,"y":0.5,"x2":0.8,"y2":0.5},
  {"type":"Up",  "x":0.2,"y":0.5,"x2":0.8,"y2":0.5}
]
```

### button — Hardware button press
```json
{ "udid": "<UDID>", "button": "home" }
```
Buttons: `home`, `back`, `power`, `volumeUp`, `volumeDown`, `appSwitch`, `actionButton`

### paste — Type text into focused field
```json
{ "udid": "<UDID>", "text": "Hello, world!" }
```
Tap the field first, then paste. If it doesn't work, use `keyboard` instead.

### keyboard — Type text or press special keys
```json
{ "udid": "<UDID>", "text": "Hello, world!" }
{ "udid": "<UDID>", "key": "enter" }
{ "udid": "<UDID>", "text": "search query", "key": "enter" }
```
Types character by character using keyboard events. More reliable than paste for custom input fields.
Special keys: `enter`, `escape`, `backspace`, `tab`, `space`, `arrow-up`, `arrow-down`, `arrow-left`, `arrow-right`, `f1`–`f12`

### rotate — Change orientation
```json
{ "udid": "<UDID>", "orientation": "LandscapeLeft" }
```
Orientations: `Portrait`, `LandscapeLeft`, `LandscapeRight`, `PortraitUpsideDown`

## Best Practices

1. **Start every task with `launch-app` or `open-url`** — never hunt for icons on the home screen.
2. **Take a screenshot before and after interactions** to verify the result.
3. **Use `swipe` for lists and scroll views**, not `gesture`, unless you need non-linear movement.
4. **Tap a text field before typing** — both `paste` and `keyboard` require focus. Try `paste` first; fall back to `keyboard` if the field doesn't respond.
5. **Wait for animations** — after `tap` or `button`, give the app ~300ms to react before the next action.
6. **Normalize coordinates** — always 0.0–1.0, not pixel values.
