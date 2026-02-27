# Simulator Interaction

Interact with the iOS simulator using touch, gestures, buttons, and text input.

## Choosing the Right Tool

| Action | Tool | When to use |
|--------|------|-------------|
| Single tap | `tap` | Buttons, links, checkboxes |
| Scroll/swipe | `swipe` | Straight-line scroll or swipe |
| Long press | `gesture` | Context menus, drag start |
| Drag & drop | `gesture` | Complex drag interactions |
| Pinch/zoom | `gesture` | Two-finger gestures |
| Hardware key | `button` | Home, back, power, volume |
| Type text | `paste` | Form fields (fastest) |
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
Tap the field first, then paste.

### rotate — Change orientation
```json
{ "udid": "<UDID>", "orientation": "LandscapeLeft" }
```
Orientations: `Portrait`, `LandscapeLeft`, `LandscapeRight`, `PortraitUpsideDown`

## Best Practices

1. **Take a screenshot before and after interactions** to verify the result.
2. **Use `swipe` for lists and scroll views**, not `gesture`, unless you need non-linear movement.
3. **Tap a text field before pasting** — `paste` requires focus.
4. **Wait for animations** — after `tap` or `button`, give the app ~300ms to react before the next action.
5. **Normalize coordinates** — always 0.0–1.0, not pixel values.
