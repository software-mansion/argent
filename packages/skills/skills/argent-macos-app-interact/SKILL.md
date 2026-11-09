---
name: argent-macos-app-interact
description: Drive a native Mac app (AppKit, SwiftUI, react-native-macos) through argent. Use when a list-devices entry has platform "macos", or the user names a Mac app, a macOS app or a native desktop app. Never for an iOS simulator, an iPhone, or an Electron or Chromium app (platform "chromium").
---

`argent-device-interact` still applies for everything not listed here (`run-sequence`, `await-ui-element`, secrets).

## Contract

- Needs the `macos-apps` flag. When a tool says it is off, tell the user to run the command it names. Do not change the flag yourself.
- One app is one device. `list-devices` shows only apps argent started that still run, also those of other sessions: never pick one unless the user named that app or this session started it.
- Start an app with `boot-device {macosAppPath: "<abs path>.app"}`, never with `open` or Xcode. Use `launch-app` only for an app argent already started: with no recorded path it takes whichever copy Spotlight finds.
- Build the `.app` without starting it: `xcodebuild ... build`, then take the bundle from `BUILT_PRODUCTS_DIR` (`xcodebuild -showBuildSettings`). Xcode Run and `react-native run-macos` start a copy without the argent library: `boot-device` then fails with `already running ... without the argent library`. Retry with `force: true`, but ask the user first when they may have work open in that copy.
- Never pass `force` when the error names another build path; report it.
- After a code change: rebuild, then `restart-app`.
- A start result with a `note` that the app showed no window: taps and screenshots need one. Tell the user, and read the log file it names.
- On a hardened-runtime refusal, report it to the user. Do not sign files or change code signing.
- Never activate the app or drive it with `osascript`, `open` or other system tools.
- At the end: `stop-all-simulator-servers {devices: ["macos-app-<bundle id>"]}` closes argent's connection; the app keeps running.

## Per-tool notes

- Swipe or drag: `gesture-drag`. Long press: `gesture-drag` with the same start and end point. Scroll: `gesture-scroll`.
- Zoom or rotate: `gesture-pinch` and `gesture-rotate` fail; use the app's own controls or shortcuts.
- After a right-click (`gesture-tap` with `button: "right"`), the returned tree lists the menu items; a plain `gesture-tap` on one chooses it (the menu can stay in the tree for a moment while it closes). `keyboard` `escape` closes the menu; `enter` chooses nothing after a right-click, so tap the item.
- No hover: a tooltip is out of reach.
- `open-url`: the URL goes to the running app. A custom scheme must be one the app declares; `http` and `https` go to the app, not the browser; a `file:` URL opens that document in the app.
- A SwiftUI `DisclosureGroup` opens only at its chevron, near the left end of its frame: a tap at the centre passes and does nothing. Tap along the left end in steps of about 0.008 until its `value` changes.
- `menu-bar` for any menu command. An item listed `[disabled]` cannot be chosen right now: an edit command (Copy, Select All) needs the text field clicked first; while an alert is open only its own commands work, so answer the alert first. When a menu of the app is open, `choose` fails: send `keyboard {key: "escape"}`, then choose again.
- Open and save panels: never click in the file list, which `describe` cannot read. Use `file-panel`, also for the Delete or Don't Save prompt of an edited new document.

## Tree

- Identifiers: AppKit accessibility identifier, SwiftUI `.accessibilityIdentifier()`, web `data-testid` (else `id`), React Native `testID` (also on a plain `View` or `Text`).
- Hint `The Mac is locked` or `fallback walk`: clicks and typing still work, elements can be missing (an open context menu among them), and a `hidden` check cannot pass. Ask the user to unlock when a target is missing.
- An action that fails or has no effect: a minimized window takes no input. Restore it by choosing it in the Window menu with `menu-bar`; without such an item, ask the user.

## E2E tests

Read `references/e2e.md` before recording or writing a test for a Mac app.

## react-native-macos

A Debug build loads JavaScript from Metro: start Metro before `boot-device` (see `argent-react-native-app-workflow`). `debugger-*` and the React profiler do not take a Mac app id: read the screen with `describe`.
