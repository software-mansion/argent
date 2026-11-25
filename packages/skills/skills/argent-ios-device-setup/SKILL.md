---
name: argent-ios-device-setup
description: Set up a physical iPhone over USB or a connected CoreDevice tunnel for argent. Use when a physical iPhone is involved (a list-devices iOS entry with kind "device") and ONLY then; never for a simulator.
---

# Physical iPhone setup

Read this only for a physical iPhone. Simulators use `argent-ios-simulator-setup`.

## First run

1. Connect the phone in Xcode through USB or a CoreDevice network tunnel. Unlock it, keep the screen awake, and enable Developer Mode (Settings > Privacy & Security > Developer Mode). `list-devices` must show it `connected`; `paired` means unreachable. A network phone's tunnel comes up on its first call. A fleet provider must expose the CoreDevice tunnel to this Mac.
2. `launch-app` only registers the app. The first `describe`, gesture or `screenshot` builds, signs and starts the on-device runner: minutes cold, tens of seconds from cache or after a tool-server restart. Build cap 15 min, runner ready 120 s.
3. On the first install the phone asks to trust the developer (Settings > General > VPN & Device Management), and an **Argent Runner** app appears on the home screen. Tell the user it is argent's automation runner and must stay installed.

## Signing and failures

Signing needs no configuration: the first call on a phone names the team it picked; `ARGENT_IOS_TEAM_ID` in the tool-server environment overrides it. Errors name their fix (cable, lock, trust, signing, a stuck runner): apply it and retry the same call. A failed build quotes xcodebuild's own `error:` lines.

For a network device, a missing tunnel requires reconnecting in Xcode or through its fleet provider. If the runner stops answering on its tunnel, Argent restarts it on the current address and retries the call once.

Then read `argent-ios-device-interact`.
