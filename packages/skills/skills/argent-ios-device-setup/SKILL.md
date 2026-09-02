---
name: argent-ios-device-setup
description: Read ONLY when a physical iPhone is involved (a list-devices iOS entry with kind "device"). First-run steps for a cabled iPhone. Never read this for a simulator.
---

# Physical iPhone setup

Read this only for a physical iPhone. Simulators use `argent-ios-simulator-setup`.

1. Cable the phone, unlock it, keep the screen awake, and turn on Developer Mode (Settings > Privacy & Security > Developer Mode). `list-devices` must show it `connected`.
2. Run the first interaction tool. It builds and signs the on-device runner: seconds from cache, minutes on a cold build.
3. On the first install the phone asks to trust the developer (Settings > General > VPN & Device Management), and an **ArgentRunner** app appears on the home screen. Tell the user it is argent's automation runner and must stay installed.

Signing needs no configuration. The result note or the error text names the team picked, the `ARGENT_IOS_TEAM_ID` override, and the fix for every signing, cable, lock, or trust failure: apply it and retry the same call.

Then read `argent-ios-device-interact`.
