# Foldable Devices

Read this for a device `list-devices` marks `foldable: true`: a foldable iOS simulator (the iPhone Duo) or Android emulator. Everything in the related SKILL.md still applies, and the `fold` description covers postures, panels and the result fields. What it does not say:

- Keep one screenshot-diff baseline per posture: the screenshot size changes with the panel.
- Fold between gestures, not during one. A gesture stays on the panel where it started.
- iOS: if argent cannot find the active panel, it uses the cover panel and sets `warning` (a screenshot-diff summary gets a `panel:` line). Take a screenshot to see what the device shows, then do the check the warning names.
- Android: on a closed generic foldable AVD, tap only full-width rows; test the cover panel on a Pixel Fold AVD.

## iPhone Duo Split View

To put an app on one half of the open Duo, use the Home Screen shortcut. A drag from the bottom edge can scroll the foreground app.

1. Open the Duo with `fold` if needed. With the UI in landscape, press `button: home` if an app is in front.
2. Find the app icon in the Home Screen tree. Long-press its center with `gesture-custom`: send `Down`, then `Up` at the same point with `delayMs: 800`.
3. Find **Open in Split View** in the menu tree (id `com.apple.springboardhome.application-shortcut-item.open-in-split`). Tap the center of that button.
4. Verify the app and the Home Screen appear side by side in the screenshot. Stop here when the request is for one app at half width.
