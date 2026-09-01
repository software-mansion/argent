---
name: argent-ios-device-setup
description: Set up and connect a physical iPhone using argent MCP tools. Use when the user wants to run or test on a real device, when list-devices shows an iOS entry with kind "device", or when a physical-device call fails with a signing, cable, or trust error.
---

# Argent physical iPhone setup

Plug in the USB cable, unlock the phone, and run the first interaction; signing is automatic in the common case. Physical iPads are not supported yet.

## 1. Connect and first run

1. Connect the USB cable. Wi-Fi is not supported.
2. Unlock the phone, keep the screen awake, and turn on Developer Mode (Settings > Privacy & Security > Developer Mode).
3. Check `list-devices`: the phone must show state `connected`. `paired` means known but unreachable and never auto-bound; reconnect the cable.
4. Run the first interaction. It builds the on-device automation runner: seconds when the build is cached, minutes on a cold build. Later sessions reuse the cache.
5. First install only, on the phone: iOS asks to trust the developer (Settings > General > VPN & Device Management), and an **ArgentRunner** app appears on the home screen. Tell the user the app is argent's automation runner, is expected, and must stay installed.

Setup is done when the first interaction succeeds. Next: read `argent-ios-device-interact` before interacting; the contract on hardware differs from simulators.

## 2. Signing (zero-config in the common case)

The tool-server signs the runner automatically from the Mac's keychain. Three outcomes:

- **One Apple Development certificate**: the team is detected from it. Nothing to configure.
- **Several teams**: the team with the newest certificate wins. The result note names the pick, the runner-up teams, and the `ARGENT_IOS_TEAM_ID` override.
- **No certificate**: the error tells the user to sign in to Xcode (Settings > Accounts), then Manage Certificates > + > Apple Development, then retry.

`ARGENT_IOS_TEAM_ID` in the **tool-server's** environment is the only explicit override; there is no config key. An export in your client shell does not reach a running server. To apply it: `argent server stop && ARGENT_IOS_TEAM_ID=<team-id> argent server start --detach`.

## 3. Troubleshooting

Match the error text, apply the fix, retry the failed call.

Connection and runner:

| Error mentions                                | Fix                                                                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Device transport is localNetwork, not wired` | Connect the USB cable; Wi-Fi is not supported. Unlock the phone, then retry.                                                                      |
| `failed to launch` / devicectl error 10002    | Unlock the device and keep the screen awake. If already unlocked, check the phone for a pending system prompt (for example a default-app choice). |
| `runner did not become ready` (+ trust hint)  | Trust the developer on the phone: Settings > General > VPN & Device Management. The full runner log is under `~/.argent/ios-device-runner/logs/`. |
| `runner exited` twice for the same app        | The app's current screen is likely crashing XCTest. Run `restart-app` for that bundle id, then retry.                                             |

Signing and provisioning:

| Error mentions                                               | Fix                                                                                                                                      |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `team has no devices`                                        | Keep the phone connected and retry: building against the connected device registers it with the team.                                    |
| `Registering the runner bundle id failed`                    | Free Personal Team app-id cap. Wait a few days and retry, or sign under a paid team.                                                     |
| `no profiles for` / provisioning profile                     | Sign the team's Apple ID into Xcode (Xcode > Settings > Accounts), then retry.                                                           |
| `errSecInternalComponent`                                    | The signing key's keychain partition list blocks codesign. Run the `security set-key-partition-list` command from the error, then retry. |
| Runner or app stops launching after about a week (free team) | Free-team provisioning profiles expire after about 7 days. Retry: the next interaction rebuilds and re-signs the runner.                 |
