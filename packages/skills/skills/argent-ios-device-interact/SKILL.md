---
name: argent-ios-device-interact
description: Interact with a physical iPhone via argent. Use when tapping, swiping, typing, or reading the screen on a physical iOS device (a list-devices iOS entry with kind "device"); the interaction contract differs from simulators. For flag, signing, cable, or trust problems, use argent-ios-device-setup first.
---

# Argent physical iOS devices

## Critical

- **Automation is app-scoped.** XCUITest drives one app at a time. `launch-app` (or `restart-app`) registers the target; `describe`, `await-ui-element`, and gestures then act on that app only. `describe`'s `bundleId` parameter is ignored on hardware.
- **System UI needs an explicit registration.** `launch-app` with `com.apple.springboard` registers without launching (SpringBoard always runs) and exposes the home screen and system dialogs to `describe`. Register the real app again afterwards.
- **A tool-server restart forgets the registration.** The first `describe` or gesture then fails with "No app is under automation on this device"; recover with `launch-app` (or `restart-app`) for the target.
- `screenshot` is the exception: it captures the whole screen and needs no registered app.

## The interaction loop

1. `describe` reads the registered app's accessibility tree with normalized frames.
2. Tap/swipe/type with the supported tools below; coordinates are 0.0 to 1.0 as everywhere else.
3. `describe` again (or `await-ui-element`) to confirm. The general tapping and sequencing rules from `argent-device-interact` still apply.

## Supported tools

`list-devices`, `launch-app`, `restart-app`, `reinstall-app`, `describe`, `screenshot`, `gesture-tap`, `gesture-swipe`, `gesture-custom`, `button`, `keyboard`, `await-ui-element`, `await-screen-idle`, `run-sequence`, the flow tools, and `stop-simulator-server`.

Everything else fails with `not supported on ios device`. Reach for the alternative instead:

| Gated tool                        | Do instead                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `gesture-pinch`, `gesture-rotate` | Drive the app's own zoom/rotate UI with taps and drags; no two-finger gestures      |
| `open-url`                        | `launch-app` the target, then navigate inside its UI                                |
| `rotate`, `shake`                 | Real motion only: rotate/shake the phone by hand, or test on a simulator            |
| `settings-permissions`            | Change the permission on the phone itself in Settings                               |
| `paste`                           | Type with `keyboard`                                                                |
| `screenshot-diff`                 | Capture full-resolution screenshots (`scale: 1.0`) and compare the PNGs on the host |

## Gesture recipes

- **Double-tap**: `gesture-tap` with `clickCount: 2` runs the native XCUITest double-tap as one gesture. Never send two separate taps.
- **Scrolling**: `gesture-swipe`; `settle: true` works and gives a momentum-free, deterministic scroll distance.
- **Edge gestures** (for example the back-swipe): the start point must sit exactly at the edge, `fromX: 0`. A start a few thousandths in reports success without triggering the OS gesture.
- **`gesture-custom` supports exactly two shapes**, always a `Down` followed by an `Up` (no `Move` waypoints, no second finger): same point = press-hold (set `delayMs` on the `Up`), different points = straight drag. Use `gesture-swipe` for scrolls.
- **`button`** presses `home`, `volumeUp`, `volumeDown`, or `actionButton`. The runner checks the hardware first, so `actionButton` on a non-Pro iPhone is rejected instead of no-opping; `power` and `appSwitch` have no XCUITest API.

## Typing

- Tap the text field first. Typing with no focused field returns "Nothing on screen has keyboard focus. Tap the text field first, then retype."
- `keyboard` carries `text`, and `enter` as the only named key. Any other named key is rejected; tap on-screen keys with `gesture-tap` instead.
- XCTest types whole strings; `delayMs` is ignored.

## Backgrounded targets

Batch 3 semantics: observation never changes the screen.

- A backgrounded target makes `describe` and `await-ui-element` fail instead of re-fronting the app. The error offers the three ways out: `screenshot` for the current screen, `launch-app` to bring the app back, or `launch-app com.apple.springboard` to describe what is actually showing.
- Mutating tools (gestures, typing) do re-front a backgrounded target, and their result then carries `reactivated: true`: the foreground screen changed as a side effect, so re-describe before the next step.

## Pitfalls

- **The AX tree has no z-order.** An overlay can cover an element the tree still lists. When a tap lands oddly, check the auto-screenshot before retrying the same point.
- **An open keyboard bloats `describe`**: a focused text field adds roughly 100 keyboard `Key` nodes to every snapshot. Prefer describing after submitting or dismissing the keyboard.
- **Flows run on hardware**, but auto-binding picks only `connected` devices (never `paired`), and `pinch`/`rotate` flow steps fail like the live tools do.
