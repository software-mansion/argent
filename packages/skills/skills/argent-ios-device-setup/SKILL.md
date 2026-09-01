---
name: argent-ios-device-setup
description: Set up and connect a physical iPhone using argent MCP tools. Use when the user wants to run or test on a real device, when list-devices shows an iOS entry with kind "device", or when a physical-device call fails with a signing, cable, or trust error.
---

Physical iPhone support works out of the box; physical iPads are not supported yet.

## 1. Signing (zero-config in the common case)

The tool-server signs the on-device automation runner automatically. Three outcomes:

- **One Apple Development certificate in the Mac's keychain**: the team is detected from it. Nothing to configure.
- **Several teams**: the team with the newest certificate wins. The result note names the pick, the runner-up teams, and the `ARGENT_IOS_TEAM_ID` override.
- **No certificate**: the error tells the user to sign in to Xcode (Settings > Accounts), then Manage Certificates > + > Apple Development, then retry.

`ARGENT_IOS_TEAM_ID` in the **tool-server's** environment is the only explicit override; there is no config key. An export in your client shell does not reach a running server. To apply it: `argent server stop && ARGENT_IOS_TEAM_ID=<team-id> argent server start --detach`.

## 2. Device prerequisites

1. **USB cable, always.** `list-devices` shows state `connected` (cabled, usable) or `paired` (known but unreachable; never auto-bound). If your device shows `paired`, reconnect the cable.
2. **Phone unlocked**, screen awake, and **Developer Mode on** (Settings > Privacy & Security > Developer Mode).
3. On the first install, iOS asks to **trust the developer**: Settings > General > VPN & Device Management on the phone.
4. An **ArgentRunner** app appears on the home screen. This is argent's automation runner; tell the user it is expected and must stay installed.
5. The first interaction **builds the runner**: seconds when the build is cached, minutes on a cold build. Later sessions reuse the cache.

Once connected, read `argent-ios-device-interact` before interacting: the contract on hardware differs from simulators.

## 3. Troubleshooting

Match the error text, apply the fix, retry the failed call:

| Error mentions                                               | Fix                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Device transport is localNetwork, not wired`                | Connect the USB cable; Wi-Fi is not supported. Unlock the phone, then retry.                                                                      |
| `failed to launch` / devicectl error 10002                   | Unlock the device and keep the screen awake. If already unlocked, check the phone for a pending system prompt (for example a default-app choice). |
| `runner did not become ready` (+ trust hint)                 | Trust the developer on the phone: Settings > General > VPN & Device Management. The full runner log is under `~/.argent/ios-device-runner/logs/`. |
| `team has no devices`                                        | Keep the phone connected and retry: building against the connected device registers it with the team.                                             |
| `Registering the runner bundle id failed`                    | Free Personal Team app-id cap. Wait a few days and retry, or sign under a paid team.                                                              |
| `no profiles for` / provisioning profile                     | Sign the team's Apple ID into Xcode (Xcode > Settings > Accounts), then retry.                                                                    |
| `errSecInternalComponent`                                    | The signing key's keychain partition list blocks codesign. Run the `security set-key-partition-list` command from the error, then retry.          |
| `runner exited` twice for the same app                       | The app's current screen is likely crashing XCTest. Run `restart-app` for that bundle id, then retry.                                             |
| Runner or app stops launching after about a week (free team) | Free-team provisioning profiles expire after about 7 days. Retry: the next interaction rebuilds and re-signs the runner.                          |
