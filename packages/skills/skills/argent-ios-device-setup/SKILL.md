---
name: argent-ios-device-setup
description: Set up a cabled physical iPhone for argent. Use when a physical iPhone is involved (a list-devices iOS entry with kind "device") and ONLY then; never for a simulator.
---

# Physical iPhone setup

Read this only for a physical iPhone. Simulators use `argent-ios-simulator-setup`.

## First run

1. Cable the phone, unlock it, keep the screen awake, and turn on Developer Mode (Settings > Privacy & Security > Developer Mode). `list-devices` must show it `connected`.
2. `launch-app` only registers the app. The first `describe`, gesture or `screenshot` builds, signs and starts the on-device runner: minutes cold, tens of seconds from cache or after a tool-server restart. Build cap 15 min, runner ready 120 s.
3. On the first install the phone asks to trust the developer (Settings > General > VPN & Device Management), and an **ArgentRunner** app appears on the home screen. Tell the user it is argent's automation runner and must stay installed.

## Signing and failures

Signing needs no configuration. The first phone call of a tool-server process carries a note naming the team picked and the `ARGENT_IOS_TEAM_ID` override (tool-server environment; a change forces a cold rebuild). Cable, lock, trust, expired-profile and missing-certificate errors name their fix: apply it, retry the same call. Also: `errSecInternalComponent`: run `security set-key-partition-list -S apple-tool:,apple:,codesign: -s ~/Library/Keychains/login.keychain-db` (asks the user's login password), retry. `team has no devices`: keep the phone cabled, retry. Bundle id registration failed: free-team app-id cap, wait days or sign under a paid team. Any other xcodebuild failure prints raw `error:` lines: read `~/.argent/ios-device-runner/logs/runner-<udid8>.log`. `RUNNER_WEDGED`: `stop-simulator-server` for the udid, retry.

Then read `argent-ios-device-interact`.
