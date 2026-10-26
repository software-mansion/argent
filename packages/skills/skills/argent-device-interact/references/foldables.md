# Foldable Devices

Read this for a device `list-devices` marks `foldable: true`: a foldable iOS simulator (the iPhone Duo) or Android emulator. Everything in the related SKILL.md still applies, and the `fold` description covers postures, panels and the result fields. What it does not say:

- Keep one screenshot-diff baseline per posture: the screenshot size changes with the panel.
- Fold between gestures, not during one. A gesture stays on the panel where it started.
- iOS: if argent cannot find the active panel, it uses the cover panel and sets `warning` (a screenshot-diff summary gets a `panel:` line). Take a screenshot to see what the device shows, then do the check the warning names.
- Android: on a closed generic foldable AVD, tap only full-width rows; test the cover panel on a Pixel Fold AVD.
