---
name: argent-settings-permissions
description: Grant, deny, or reset an app's runtime permissions (camera, microphone, photos, contacts, notifications, calendar, location, location-always, media-library, motion, reminders) on an iOS simulator or Android device using the argent `settings-permissions` tool — without navigating the system Settings UI. Use when the permission cannot be changed through the app itself — and only then, pre-authorize before the app asks, deny up front, re-enable a permission the user already denied, or reset so the prompt reappears. If the app can flip it — via an in-app toggle or the system permission dialog the app triggers — interact with the app instead.
---

## What this tool is for

`settings-permissions` edits the platform's permission store directly — the iOS simulator's TCC database via `xcrun simctl privacy`, or Android's package-manager permission flags via `pm grant` / `pm revoke`. It replaces the manual **Settings → Privacy** dance during test setup: pre-authorize a service so the app never has to ask, deny it up front to test the refusal path, or reset it so the first-run dialog appears again on the next launch.

It is a **test-setup / out-of-band** tool, not a general permissions toggle. The default way to change a permission is still through the app — this tool is the exception for the cases the app can't reach.

## When to use it — and when NOT to

Decide with this order. The first matching row wins.

| Situation                                                                                                        | Do this                                                                                       | Why                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The app has an **in-app control** for the permission (a toggle in its own settings screen)                       | **Tap it in the app** (`describe` → `gesture-tap`) — do NOT use this tool                     | It's real user behavior and exercises the flow you're testing. See `argent-device-interact`.                                                                         |
| The app is **about to ask** (or just asked) and the system **permission dialog is on screen**                    | **Tap the dialog** (`Allow` / `Don't Allow` / `Allow While Using App`) — do NOT use this tool | The app-triggered prompt is the natural path; answering it is what a user does. `describe` exposes the dialog buttons; fall back to `screenshot` only if it doesn't. |
| You need the permission **already granted/denied before the app runs**, so no dialog interrupts the flow         | **Use this tool** (`grant` / `deny`) before `launch-app`                                      | The app can't pre-set its own permission; a real user would do it in Settings. This is the core use case.                                                            |
| The user **already denied** it and you need it **on** again                                                      | **Use this tool** (`grant`)                                                                   | iOS never re-shows a dialog once denied — the only in-device path is the Settings app. This tool is the shortcut.                                                    |
| You need the **first-run dialog to appear again** (test the prompt itself, or reset dirty state)                 | **Use this tool** (`reset`)                                                                   | Returns the permission to "not yet asked" so the app prompts on next use.                                                                                            |
| The permission is **not one this tool supports** on the target platform (see the support table)                  | **Do NOT use this tool**                                                                      | It will return an "unsupported" error. Use the app dialog if the app triggers one, or navigate the real Settings app.                                                |
| The setting isn't one of the **11 runtime permissions** below (e.g. Wi-Fi, cellular data, dark mode, VPN, Focus) | **Do NOT use this tool**                                                                      | Out of scope — drive the Settings app or the app's own UI instead.                                                                                                   |

**Rule of thumb:** if a human tester could flip it _inside the app_, do that. Reach for `settings-permissions` only for a change a human would otherwise make in the **system Settings app**.

## Supported permissions & platform coverage

| `permission`      | iOS simulator (`simctl privacy` service)                                                       | Android (`android.permission.*`)                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `camera`          | `camera` — only if the installed Xcode's simctl models it (simulators have no camera hardware) | `CAMERA`                                                                                                  |
| `microphone`      | `microphone`                                                                                   | `RECORD_AUDIO`                                                                                            |
| `photos`          | `photos`                                                                                       | `READ_MEDIA_IMAGES` + `READ_MEDIA_VIDEO` + `READ_EXTERNAL_STORAGE`                                        |
| `contacts`        | `contacts`                                                                                     | `READ_CONTACTS` + `WRITE_CONTACTS`                                                                        |
| `notifications`   | **unsupported** — no simctl service; answer the app's dialog instead                           | `POST_NOTIFICATIONS`                                                                                      |
| `calendar`        | `calendar`                                                                                     | `READ_CALENDAR` + `WRITE_CALENDAR`                                                                        |
| `location`        | `location`                                                                                     | `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION`                                                         |
| `location-always` | `location-always`                                                                              | `ACCESS_BACKGROUND_LOCATION` (a **grant** also adds fine + coarse — background alone can't read location) |
| `media-library`   | `media-library`                                                                                | `READ_MEDIA_AUDIO` + `READ_EXTERNAL_STORAGE`                                                              |
| `motion`          | `motion`                                                                                       | `ACTIVITY_RECOGNITION`                                                                                    |
| `reminders`       | `reminders`                                                                                    | **unsupported** — no Android runtime permission                                                           |

One abstract permission can map to several concrete Android permissions; which ones actually exist depends on the app's manifest and the device's API level (e.g. `READ_MEDIA_*` on API 33+ vs `READ_EXTERNAL_STORAGE` below it).

## Actions

- **`grant`** — pre-authorize the permission. Requires `bundleId`.
- **`deny`** — refuse it (iOS `revoke`). Requires `bundleId`. Use to test the app's "permission denied" path.
- **`reset`** — return to the not-yet-asked state so the dialog reappears on next use.
  - iOS: `bundleId` is optional; omitting it asks simctl to reset the service for **all** apps. On recent iOS runtimes a device-wide reset can leave existing per-app entries untouched — **prefer passing `bundleId`**.
  - Android: `bundleId` is **required** (`pm revoke` + `pm clear-permission-flags` are per-package; there is no device-wide reset).

## Parameters

```json
{
  "udid": "<UDID-or-serial>",
  "action": "grant",
  "permission": "camera",
  "bundleId": "com.example.app"
}
```

- `udid` — target from `list-devices` (iOS simulator UDID, or Android serial). See `argent-ios-simulator-setup` / `argent-android-emulator-setup` to get one.
- `action` — `grant` | `deny` | `reset`.
- `permission` — one of the 11 names above.
- `bundleId` — iOS bundle id or Android package name. Required for `grant`/`deny` (schema-enforced) and for every action on Android. Optional only for iOS `reset`.

## Platform behavior

**iOS simulator only.** Runs `xcrun simctl privacy <udid> grant|revoke|reset <service> [bundleId]`. There is no host-side TCC switch on a physical iPhone, so this tool does not apply to real iOS devices. The simulator must be **booted** first (`boot-device`) — otherwise simctl fails with a "current state: Shutdown" error and the tool surfaces the boot hint.

**Android emulator and physical device.** Runs `pm grant` / `pm revoke` (and, for `reset`, `pm clear-permission-flags … user-set user-fixed`) over adb. Requirements:

- The app must be **installed** — the tool probes with `pm path` first and errors clearly if the package is missing.
- The app must **declare** the permission in its manifest. `pm` rejects any mapped permission the manifest doesn't request; those come back in the result's `skipped` list. The action succeeds if **at least one** mapped permission sticks, and errors only if `pm` rejected **all** of them.

## Gotchas

- **Changing a permission can terminate a running app** (system behavior on both platforms). Prefer setting permissions **before** `launch-app`; if you change one while the app is running, `restart-app` afterward.
- **Don't chase a device-wide reset on Android** — it's per-package only; pass `bundleId`.
- **A partial Android result is normal.** `applied` lists what actually changed; `skipped` lists mapped permissions `pm` rejected (usually not in the manifest, or gated by API level). Both together tell you what happened.
- **`camera` on iOS** may be rejected by an older Xcode whose simctl doesn't model it — the tool wraps simctl's "invalid service" error with a hint to run `xcrun simctl privacy` to list supported services.

## Result

Returns `{ action, permission, bundleId?, applied, skipped? }`:

- `applied` — the platform-level services/permissions actually changed (the simctl service on iOS; the `android.permission.*` names on Android).
- `skipped` — Android only, present when some mapped permissions were rejected but others succeeded.

The call **fails** if nothing could be applied (unsupported permission for the platform, app not installed, or `pm` rejected everything) — read the error; it names the reason (missing manifest entry, shutdown simulator, unsupported service).

## Examples

Pre-grant the camera before launching, so the app never prompts:

```json
{ "udid": "<UDID>", "action": "grant", "permission": "camera", "bundleId": "com.example.app" }
```

Test the denied path — refuse location, then launch and observe the fallback:

```json
{ "udid": "<serial>", "action": "deny", "permission": "location", "bundleId": "com.example.app" }
```

Reset notifications on Android so the first-run prompt appears again next launch:

```json
{
  "udid": "<serial>",
  "action": "reset",
  "permission": "notifications",
  "bundleId": "com.example.app"
}
```

Grant always-on location on Android (fans out to background + foreground automatically):

```json
{
  "udid": "<serial>",
  "action": "grant",
  "permission": "location-always",
  "bundleId": "com.example.app"
}
```
