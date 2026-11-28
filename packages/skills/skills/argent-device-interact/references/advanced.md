# Advanced Interaction Notes

## Tool Reference

| Action                      | Tool                                     | Notes                                                                   |
| --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Several known steps         | `run-sequence`                           | One call, one screenshot at the end                                     |
| Open / restart app          | `launch-app` / `restart-app`             | Never tap home-screen icons; `restart-app` clears in-memory state       |
| Open URL / deep link        | `open-url`                               | Web pages, deep links, URL schemes                                      |
| Tap / swipe                 | `gesture-tap` / `gesture-swipe`          | Touch targets; not Chromium for swipe                                   |
| Scroll / drag (Chromium)    | `gesture-scroll` / `gesture-drag`        | Mouse wheel; sliders, drag-and-drop, text selection                     |
| Long press, drag & drop     | `gesture-custom`                         | Also any non-linear touch sequence                                      |
| Pinch / rotate gesture      | `gesture-pinch` / `gesture-rotate`       | Two-finger gestures                                                     |
| Hardware key / rotate       | `button` / `rotate`                      | Home, back, power, volume, appSwitch, actionButton; orientation changes |
| Shake device                | `shake`                                  | Shake handlers (sim/emu only), Undo-typing prompt, RN dev menu          |
| Fold device                 | `fold`                                   | Foldables only (`references/foldables.md`)                              |
| Type text / press named key | `keyboard`                               | Every platform; text or one key per call                                |
| Paste text                  | `paste`                                  | Only where a user would paste; sim/emu, Mac app                         |
| Device-wide setting         | `system-settings`                        | Dark mode, text size, a11y toggles, Android radios                      |
| Slow or offline network     | `network-conditions`                     | iOS sim app, Android emu, or Chromium tab                               |
| Wait for UI / idle          | `await-ui-element` / `await-screen-idle` | Server-side waits                                                       |

## Network Conditions Recovery

After a network test, call `network-conditions` with the same target and omit the conditions to reset. On Android, this brings an offline emulator back online. If an Argent crash leaves an emulator's proxy active, reset before retrying.

## Discovery & React Native LogBox

- **UIKit view lookup (iOS simulator):** `native-find-views` (needs `bundleId` and a class, id, label, tag, or `nativeID`) and `native-view-at-point` (visually deepest view; `hitTest: true` for touch target).
- **React Native component names / testIDs:** `debugger-component-tree` when `describe` omits them; still take tap points from `describe`.
- **React Native LogBox toasts:** sit over the bottom of the screen and catch taps meant for what is under them. Argent hides them when a `debugger-*` tool connects and after `debugger-reload-metro`; after `restart-app`, call a `debugger-*` tool again. After any other reload they come back: close each by tapping the right end of its `describe` frame (the X), not its middle.
- **Empty `describe` tree:** follow its `hint` if present. If there's no hint, the screen is blank, loading, or unlabeled. Check the attached screenshot and retry once content loads.
- **System / permission dialogs:** on a simulator or emulator, `describe` returns visible dialog buttons with tap coordinates (and in-app modals too). Fall back to `screenshot` only if `describe` omits them. Tap one obvious button (`Allow`, `OK`, `Don't Allow`, `Not Now`, `Continue`) at a time, check the screenshot, and return to `describe` once dismissed. Prefer answering the app's own dialog over `settings-permissions`. Use `settings-permissions` only to pre-authorize, re-enable a denied permission (iOS won't re-prompt), or reset prompts. See `argent-settings-permissions`.

## Waiting: `await-ui-element` and `await-screen-idle`

- `await-ui-element` blocks server-side on the same tree `describe` reads. It has no bare-timer mode; for a plain pause, use your own harness sleep.
- The synthetic `ROOT` container `describe` prints is never matched, so a `role` like `AXGroup`/`html` won't trivially match the screen.
- To disambiguate a loose selector, pin `role` to a text role like `StaticText` to skip a same-named button.
- `await-screen-idle` is for live diagnosis after a launch or navigation before a raw tap on a moving element. Continue only when `settled: true`, and pair it with `await-ui-element` for the destination: stillness does not identify a screen, and the tool can return during a presentation-layer animation. Do not record it in an e2e test; tests use `await: { idle: true }`, which also compares pixels.

## Action Sequencing with `run-sequence`

Use `run-sequence` when every step is known in advance; if a step depends on what the previous one shows, use separate calls. Typical batches:

- Scroll to bottom / until X: 3–5 swipes
- Clear and retype a field: triple-tap to select all, then type
- Type then submit: a `keyboard` text step, then a `keyboard` `enter` step
- Submit form: fill every field, then tap submit
- Known tap path: e.g. navigating back through screens

Use `await-ui-element` to gate a step on a screen transition. To gate on an HTTP request, start capture before the sequence and put `await-network-request` after the triggering action. A failed step (including a wait with `success: false`) stops the sequence with partial results.

## Text Entry, Paste & Secrets

- Tap the field first; typing or pasting with no focused field is a silent no-op.
- `paste` is **not** a faster `keyboard`. Keep `keyboard` as the default; use `paste` only where a real user would paste (OTP/2FA codes, long links/tokens, or testing paste handling). Platform text limitations alone are not a reason to switch to `paste`.
- **Credentials:** pass `{{secret:<NAME>}}` placeholders in `text` (`keyboard`, `paste`, `run-sequence` keyboard steps, e2e `type` steps), never plaintext, and never ask the user for the value. Do **not** `describe` or `screenshot` a non-secure field you just filled with a secret: submit or navigate away first, then verify the resulting screen.

## Screenshots & Android Notes

- Call `screenshot` for initial state, baselines before visible UI changes, state after a delay, or when an attached capture shows a transitional/loading frame.
- Keep the default downscaled capture for routine checks; reserve `scale: 1.0` (with `includeImageInContext: false`) for saving baselines/currents for `argent-screenshot-diff`.
- If `screenshot` times out, restart the device transport with `stop-simulator-server`.
- **Android first-launch permissions:** `reinstall-app` on Android installs with `-g`, pre-granting runtime permissions on first launch.
