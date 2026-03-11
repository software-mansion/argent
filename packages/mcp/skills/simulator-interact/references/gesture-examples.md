# Gesture Examples

Detailed `gesture` tool sequences for complex touch interactions.

## gesture — Custom touch sequence

```json
{
  "udid": "<UDID>",
  "events": [
    { "type": "Down", "x": 0.5, "y": 0.5 },
    { "type": "Up",   "x": 0.5, "y": 0.5, "delayMs": 800 }
  ]
}
```

## Long Press (800ms hold)

```json
[
  { "type": "Down", "x": 0.5, "y": 0.5 },
  { "type": "Up",   "x": 0.5, "y": 0.5, "delayMs": 800 }
]
```

## Pinch Out (zoom in)

```json
[
  { "type": "Down", "x": 0.4, "y": 0.5, "x2": 0.6, "y2": 0.5 },
  { "type": "Move", "x": 0.2, "y": 0.5, "x2": 0.8, "y2": 0.5 },
  { "type": "Up",   "x": 0.2, "y": 0.5, "x2": 0.8, "y2": 0.5 }
]
```

## Pinch In (zoom out)

```json
[
  { "type": "Down", "x": 0.2, "y": 0.5, "x2": 0.8, "y2": 0.5 },
  { "type": "Move", "x": 0.4, "y": 0.5, "x2": 0.6, "y2": 0.5 },
  { "type": "Up",   "x": 0.4, "y": 0.5, "x2": 0.6, "y2": 0.5 }
]
```

## Drag and Drop

```json
[
  { "type": "Down", "x": 0.3, "y": 0.4 },
  { "type": "Move", "x": 0.3, "y": 0.4, "delayMs": 500 },
  { "type": "Move", "x": 0.7, "y": 0.6 },
  { "type": "Up",   "x": 0.7, "y": 0.6 }
]
```

Add a `delayMs` on the first `Move` to simulate a hold before dragging — this is required for some drag-and-drop implementations that only activate after a sustained press.
