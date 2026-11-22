# Foldable Devices

Read this for a device `list-devices` marks `foldable: true`: a foldable iOS simulator (the iPhone Duo) or Android emulator. Everything in the related SKILL.md still applies, and the `fold` description covers postures, panels and the result fields. What it does not say:

- Keep one screenshot-diff baseline per posture: the screenshot size changes with the panel.
- Fold between gestures, not during one. A gesture stays on the panel where it started.
- iOS: if argent cannot find the active panel, it uses the cover panel and sets `warning` (a screenshot-diff summary gets a `panel:` line). Take a screenshot to see what the device shows, then do the check the warning names.
- Android: on a closed generic foldable AVD, tap only full-width rows; test the cover panel on a Pixel Fold AVD.

## Move a full-screen app into Split View on iPhone Duo

Start with the Duo open in landscape and the app full screen. If needed, use `fold` to open the Duo and `launch-app` to open the app.

Call `gesture-custom` once with the Duo UDID and these parameters to move the app to the **left**. The `edge` field tells iOS that the touch starts a system gesture. Keep the finger down through the pause and the sideways drag.

```json
{
  "edge": "bottom",
  "interpolate": 12,
  "events": [
    { "type": "Down", "x": 0.5, "y": 1 },
    { "type": "Move", "x": 0.5, "y": 0.5, "delayMs": 280 },
    { "type": "Move", "x": 0.5, "y": 0.5, "delayMs": 300 },
    { "type": "Move", "x": 0.14, "y": 0.5, "delayMs": 320 },
    { "type": "Up", "x": 0.14, "y": 0.5, "delayMs": 200 }
  ]
}
```

For the **right**, change both final x coordinates to `0.86`. Check the screenshot for the app on the requested side and the Home Screen on the other. Stop here if the user asked for one app at half width.
