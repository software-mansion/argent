# @argent/ios-device-runner

Argent's on-device automation runner for **physical iOS devices**: an XCUITest
bundle that, instead of running a scripted test, starts an HTTP command server
and parks in an `XCTWaiter` wait for 24 hours. XCUITest is the only
Apple-supported process allowed to drive arbitrary apps on real hardware, so
Argent hosts its automation server inside one. The whole feature is gated
behind the experimental `ios-physical-devices` flag, off by default.

## Layout

```
ArgentRunner/
  ArgentRunner.xcodeproj      Two targets: ArgentRunner (placeholder host app)
                              and ArgentRunnerUITests (the runner itself).
  ArgentRunner/               Host app: a single black "Argent Runner" screen.
  ArgentRunnerUITests/
    ArgentRunnerSession.swift            Entry test + dispatch, coalescing, busy gate
    ArgentRunnerSession+Commands.swift   Target resolution, exception guard,
                                         recorded-failure detection,
                                         button / shutdown
    ArgentRunnerSession+Gestures.swift   tap / longPress / drag / viewport
    ArgentRunnerSession+TextEntry.swift  type / keyboardReturn
    ArgentRunnerSession+Snapshot.swift   one-shot AX tree capture + flattening
    ArgentRunnerSession+Screenshot.swift inline base64 PNG
    RunnerProtocol.swift                 wire models (see PROTOCOL.md)
    RunnerHTTPServer.swift               NWListener HTTP/1.1 framing
    CommandJournal.swift                 send-once bookkeeping for lost replies
    MainThreadGate.swift                 watchdog + busy/wedged reporting
    ArgentExceptionGuard.{h,m}           @try/@catch shim for XCTest NSExceptions
```

The TypeScript side (build orchestration, transport, command client) lives in
`packages/tool-server/src/utils/ios-device/`.

## How it runs

1. The tool-server builds this project lazily with `xcodebuild
build-for-testing` (signed with the user's team; see the environment
   variables below) into `~/.argent/ios-device-runner/derived`, stamped with
   a fingerprint of sources + Xcode + signing; a stamp mismatch (an Argent or
   Xcode update, a team change) rebuilds in place.
2. Per session it launches `xcodebuild test-without-building` detached with
   the session's port as `TEST_RUNNER_ARGENT_RUNNER_PORT` in the environment
   (xcodebuild forwards `TEST_RUNNER_`-prefixed variables, prefix stripped,
   into the runner process); testmanagerd installs and starts the runner on
   the device.
3. Commands travel as one HTTP POST per command over usbmux (USB cable
   only). `PROTOCOL.md` documents the contract.

## Build-time configuration

The signing team resolves in two steps, and the environment variable wins:

- `ARGENT_IOS_TEAM_ID` (optional): your Apple Developer Team ID, a
  10-character code. Find it in Xcode > Settings > Accounts (select your
  Apple ID and team) or at developer.apple.com/account under Membership.
- When it is not set, the tool-server detects the team from the Mac's
  keychain: the Apple Development certificates name their team (and the
  legacy iPhone Developer name is checked too), and with several teams the
  one with the newest certificate wins. The detection result is memoized for
  the tool-server process. With no certificate at all, the build fails with a
  prompt to sign into Xcode and mint one (Manage Certificates > + > Apple
  Development).

Everything else is derived or fixed. The build always uses automatic signing
(an Apple ID signed into Xcode is needed so it can mint the provisioning
profile), and the bundle ids are derived from the team
(`com.argent.runner.t<teamid>` plus its `.uitests` sibling), which makes them
unique per team by construction. The project intentionally hardcodes no team
and only placeholder bundle ids; the tool-server injects the real values on
the `xcodebuild` command line. The device needs Developer Mode enabled
(Settings > Privacy & Security > Developer Mode), and on first install iOS
asks to trust the developer on the phone: Settings > General > VPN & Device
Management.

The Xcode project itself needs no locating either: it always sits next to the
bundled tool-server. An npm install of `@swmansion/argent` ships these Swift
sources there (the build step copies `ArgentRunner/` next to the bundle), and
in the argent repo `npm run build` in `packages/argent` produces the same
layout.
`ARGENT_IOS_RUNNER_PROJECT` overrides the location for tool-server runs
outside the bundle (ts-node, tests) or unusual layouts.

## Reliability model

- **Issue suppression**: `record(_:)` mutes two benign "Failed to get
  matching snapshot" accessibility issue shapes that would otherwise tear the
  long-lived test down; hung-query timeouts still record.
- **Watchdog**: command work runs on the main thread under a hard budget;
  overruns are abandoned (XCTest work cannot be cancelled) and the runner
  answers `RUNNER_BUSY`, escalating to `RUNNER_WEDGED` when stuck.
- **Send-once**: commands are journaled by `commandId` (responses are
  retained for mutating commands only); a client that lost a reply asks
  `status` for the command's fate instead of replaying it. Duplicate
  in-flight sends coalesce onto the single execution.
- **Explicit targeting**: app commands require `appBundleId`; the runner
  never redirects them to its own host app.
