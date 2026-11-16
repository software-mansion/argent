---
name: argent-settings-permissions
description: Grant, deny, or reset an app's runtime permissions (camera, microphone, photos, contacts, notifications, calendar, location, location-always, media-library, motion, reminders) on an iOS simulator or Android device using the argent `settings-permissions` tool - without navigating the system Settings UI. Use when the permission cannot be changed through the app itself - and only then, pre-authorize before the app asks, deny up front, re-enable a permission the user already denied, or reset so the prompt reappears. If the app can flip it - via an in-app toggle or the system permission dialog the app triggers - interact with the app instead.
---

`settings-permissions` edits the platform's permission store directly (the iOS simulator's TCC database, Android's runtime permissions over adb). It is a **test-setup / out-of-band** tool, not a general permissions toggle: the default way to change a permission is still through the app. The tool's description covers the supported permissions per platform, the parameters, the result (`applied` / `skipped`) and the per-platform requirements.

## When to use it - and when NOT to

The first matching row wins.

| Situation                                                                                                                             | Do this                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| The app has an **in-app control** for the permission (a toggle in its own settings screen)                                            | **Tap it in the app** (`describe` → `gesture-tap`); it exercises the flow you're testing               |
| The app asked and the **system permission dialog is on screen**                                                                       | **Tap the dialog** (`Allow` / `Don't Allow` / `Allow While Using App`); `describe` exposes its buttons |
| The permission must be **granted/denied before the app runs**, so no dialog interrupts the flow                                       | **Use this tool** (`grant` / `deny`) before `launch-app`                                               |
| The user **already denied** it and you need it **on** again                                                                           | **Use this tool** (`grant`): iOS never re-shows a dialog once denied                                   |
| You need the **first-run dialog to appear again**                                                                                     | **Use this tool** (`reset`)                                                                            |
| The permission is unsupported on the target platform, or it isn't one of the 11 runtime permissions (Wi-Fi, dark mode, VPN, Focus, …) | **Do NOT use this tool**: answer the app's dialog, or drive the Settings app or the app's own UI       |

**Rule of thumb:** if a human tester could flip it _inside the app_, do that. Reach for `settings-permissions` only for a change a human would otherwise make in the **system Settings app**.

## Gotchas

- **iOS simulator only on Apple platforms.** A physical iPhone has no host-side TCC switch, so the tool does not apply there.
- **A pre-launch `deny` suppresses the prompt on iOS only.** On iOS a TCC denial answers the app's request, so no dialog appears. On Android a `deny` clears the grant but sets no "user-fixed" flag, so the app's next request still shows the system dialog: a pre-launch `deny` there tests the revoked _state_, not a suppressed prompt.
- **Android `reset` below API 33 can't clear "don't ask again".** It revokes the grant, but clearing the user-fixed flag needs Android 13 / API 33+, so the dialog may stay suppressed on older devices.
- **Set permissions before `launch-app`.** A change can terminate a running app; if you change one while it runs, `restart-app` afterwards.
- **Android `location-always`**: a `grant` also adds fine and coarse location, since background alone can't read location.
