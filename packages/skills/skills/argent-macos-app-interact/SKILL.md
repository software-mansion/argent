---
name: argent-macos-app-interact
description: Drive a native Mac app (AppKit, SwiftUI, react-native-macos) through argent. Use when a list-devices entry has platform "macos", or the user names a Mac app, a macOS app or a native desktop app. Never for an iOS simulator, an iPhone, or an Electron or Chromium app (platform "chromium").
---

# Mac app interaction

Read this for a Mac app. `argent-device-interact` still applies for everything not listed here (`run-sequence`, `await-ui-element`, secrets).

## Contract

- Needs the `macos-apps` flag. When a tool answers `the macos-apps flag is off`, or `list-devices` shows no Mac app the user expects, tell the user to run `argent enable macos-apps`. Do not change the flag yourself.
- One app is one device: id `macos-app-<bundle id>`, from `list-devices` (`platform: "macos"`). It lists only apps argent started that still run.
- Start an app with `boot-device {macosAppPath: "<abs path>.app"}`, never with `launch-app`, `open` or Xcode. A Mac app id as `udid` starts it again from its last path; `force: true` quits and starts it again.
- The `.app` must be built without starting it: `xcodebuild ... build`, then find the bundle under the build products directory (`xcodebuild -showBuildSettings` gives `BUILT_PRODUCTS_DIR`). Xcode Run and `react-native run-macos` start a copy without the argent library: `boot-device` and `launch-app` then fail with `already running ... without the argent library`. Retry `boot-device` with `force: true`: it quits that copy and starts the app with the library. That copy loses its unsaved changes, so ask the user first when they may have work open in it. `restart-app` and an e2e `launch` step quit such a copy too.
- Never pass `force` when the error names another build path or another tool-server; report it.
- After a code change: rebuild, then `restart-app`.
- A start result with a `note` that the app showed no window: taps and screenshots need one. Tell the user, and read the log file it names.
- On a hardened-runtime refusal, report it to the user. Never sign files or change code signing yourself.
- `launch-app` and `restart-app` take only the device's own bundle id. A different bundle id fails: use that app's device id.
- Coordinates are fractions of the area `describe` reports: the app window, grown to hold sheets, alerts and menus past it. Take them from `describe` or from the tree appended after each action, never from a screenshot.
- Never activate the app or drive it with `osascript`, `open` or other system tools.
- At the end: `stop-all-simulator-servers {devices: ["macos-app-<bundle id>"]}` closes argent's connection; the app keeps running.

## Per-tool notes

- Swipe or drag: `gesture-drag`; a drop lands only inside the app's own windows. Long press: `gesture-drag` with the same start and end point. Scroll: `gesture-scroll` (positive `deltaY` scrolls down; it fails when nothing under the point scrolls). Double-click: `gesture-tap` with `clickCount: 2`. Zoom or rotate: the app's own controls or shortcuts.
- Context menu: `gesture-tap` with `button: "right"` on the element. The returned tree lists the menu items; a plain `gesture-tap` on one chooses it (the menu can stay in the tree for a moment while it closes). `keyboard` `escape` closes the menu without a choice; `enter` chooses nothing after a right-click, so tap the item.
- No hover: a tooltip is out of reach.
- `keyboard`: `text` types any character, accents and emoji included. `key` also takes `delete`, `home`, `end`, `page-up`, `page-down`, and shortcuts with modifiers joined by `+`: `command+a`, `command+s`, `shift+tab`, `command+shift+z`. Click the field first.
- `paste` inserts the text at the focused field. `does not accept text` means nothing editable has focus: `gesture-tap` the field, then retry.
- `open-url`: the URL goes to the running app. A custom scheme must be one the app declares; `http` and `https` go to the app, not the browser; a `file:` URL opens that document in the app.
- `native-*` tools: pass the device's bundle id as `bundleId`; `x`, `y` are points from the top-left of that area, not fractions.
- `native-network-logs` (the app's `NSURLSession` requests, also react-native-macos `fetch`): the first call starts the capture and returns nothing older. Call it once, repeat the action, then call it again; for launch requests, `restart-app` after the first call. Each app start has its own log.
- `menu-bar`: for any menu command; the menu bar is not in `describe`. An item listed `[disabled]` cannot be chosen right now: an edit command (Copy, Select All) needs the text field clicked first; while an alert is open only its own commands work, so answer the alert first. On `A menu is open`, send `keyboard {key: "escape"}`, then choose again.

## File panels

A click that opens an open or save panel shows a file list that `describe` cannot read. Never click in that list.

1. After the click: `file-panel {action: "choose", path: "/abs/path"}`. It waits up to `timeoutMs` (default 5000) for the panel. A save panel takes the file to write, in an existing folder; its extension picks the file format.
2. To close it instead: `file-panel {action: "cancel"}`. The app keeps the document open. When an edited new document closes or the app quits, `discard` (the panel's Delete or Don't Save button, `discardButton` in `list`) closes the document without saving.
3. To skip the panel: `file-panel {action: "stub", path: "/abs/path"}` before the click; the next panel is answered without appearing.
4. With more than one panel open, `file-panel {action: "list"}`, then pass `panel`.

## Tree

- Identifiers: AppKit accessibility identifier, SwiftUI `.accessibilityIdentifier()`, web `data-testid` (else `id`), React Native `testID` (also on a plain `View` or `Text`).
- Hint `The Mac is locked` or `fallback walk`: clicks and typing still work, elements can be missing (an open context menu among them), and a `hidden` check cannot pass. Ask the user to unlock when a target is missing.
- Hint `did not answer`: `describe` again.
- An action with no effect: check that the window is not minimized; a minimized window takes no input. Ask the user to restore it.

## E2E tests

- Record the launch as a `restart-app` step; it becomes `launch: <bundle id>`, or `launch: { macos: { app, args } }` when the app ran with arguments. Write it as `launch: { macos: <bundle id> }` so the runner picks the Mac app and starts it even when it does not run or other devices run. Otherwise run with `platform: "macos"` (`argent e2e run <name> --platform macos`), or pass the device id: without them the runner never picks a Mac app.
- A `swipe` is a mouse drag, a `long-press` a press and hold. `pinch` and `rotate` fail.
- A right-click is `tap: { on: <selector>, button: right }`; a recorded `gesture-tap` with `button: "right"` is written that way.
- A file panel is a `tool: file-panel` step, a menu command a `tool: menu-bar` step (`args: { action: choose, path: [Edit, Select All] }`). Gate a branch with `when: { platform: macos }`.

## react-native-macos

A Debug build loads JavaScript from Metro: start Metro before `boot-device` (see `argent-react-native-app-workflow`). `debugger-*` and the React profiler do not take a Mac app id: read the screen with `describe`.
