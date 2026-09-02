---
name: argent-ios-device-interact
description: Read ONLY when a physical iPhone is involved (a list-devices iOS entry with kind "device"). The hardware contract that differs from simulators. Never read this for a simulator. For cable, trust, or signing problems read argent-ios-device-setup.
---

- Observation never changes the screen; mutation may. `describe` and `await-ui-element` fail on a backgrounded target instead of re-fronting it. Gestures and `keyboard` re-front it and return `reactivated: true`; re-describe before the next step.
- Only these tools exist on hardware: `list-devices`, `launch-app`, `restart-app`, `reinstall-app`, `open-url`, `describe`, `screenshot`, `screenshot-diff`, `gesture-tap`, `gesture-swipe`, `gesture-custom`, `button`, `keyboard`, `await-ui-element`, `await-screen-idle`, `run-sequence`, the flow tools, and `stop-simulator-server`. Everything else fails with `not supported on ios device`. There are no two-finger gestures, `rotate`, `shake`, `paste`, or `settings-permissions`: drive the app's own zoom and rotate UI with taps and drags, move the phone by hand, type with `keyboard`, and change permissions in the phone's Settings.
- Each tool's description states its own hardware limits (named keys, `gesture-custom` shapes, buttons, edge swipes, tap counts), and every failure names its fix.
