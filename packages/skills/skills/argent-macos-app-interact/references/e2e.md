# E2E tests on a Mac app

- Record the launch as a `restart-app` step, then write it as `launch: { macos: <bundle id> }` (keep `{ app, args }` if the recorder wrote args) so the runner picks the Mac app and starts it. Otherwise run with `--platform macos` or the device id: without them the runner never picks a Mac app.
- A `swipe` is a mouse drag, a `long-press` a press and hold. `pinch` and `rotate` fail.
- A right-click is `tap: { on: <selector>, button: right }`.
- A file panel is a `tool: file-panel` step, a menu command a `tool: menu-bar` step (`args: { action: choose, path: [Edit, Select All] }`). Gate a branch with `when: { platform: macos }`.
