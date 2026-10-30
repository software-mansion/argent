---
name: argent-ios-device-setup
description: Set up a cabled physical iPhone for argent. Use when a physical iPhone is involved (a list-devices iOS entry with kind "device") and ONLY then; never for a simulator.
---

# Physical iPhone setup

Read this only for a physical iPhone. Simulators use `argent-ios-simulator-setup`.

## First run

1. Cable the phone, unlock it, keep the screen awake, and turn on Developer Mode (Settings > Privacy & Security > Developer Mode). `list-devices` must show it `connected`.
2. `launch-app` only registers the app. The first `describe`, gesture or `screenshot` builds, signs and starts the on-device runner: minutes cold, tens of seconds from cache or after a tool-server restart. Build cap 15 min, runner ready 120 s.
3. On the first install the phone asks to trust the developer (Settings > General > VPN & Device Management), and an **Argent Runner** app appears on the home screen. Tell the user it is argent's automation runner and must stay installed.

## Signing and failures

Signing needs no configuration: the first phone call names the team it picked and how to override it. Errors name their fix (cable, lock, trust, signing, a stuck runner): apply it and retry the same call. A failed build quotes xcodebuild's own `error:` lines.

Then read `argent-ios-device-interact`.
