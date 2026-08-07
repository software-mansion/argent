---
name: argent-push-notifications
description: Deliver a simulated push notification to an app on the iOS simulator with the argent `push-notification` tool — no APNS server, device token, or signing — then verify, read, or tap the banner. Use when testing how an app receives, displays, or deep-links from a push notification, simulating a remote notification, sending a silent/background push (content-available), setting the app badge, or reproducing a notification-tap flow. iOS simulators only — physical devices, Android, and remote simulators are not supported.
---

## What this tool is for

`push-notification` injects a push into the iOS simulator exactly as if APNS had delivered it — the app's notification handlers run, the banner animates in from the top, the badge updates. Nothing real is involved: no push certificate, no device token, no network. It is the tool for testing the _receiving_ side of push: presentation, payload handling, deep links from a notification tap, badge counts, and silent background updates.

It delivers to **one app on one simulator**: the app must be installed on the target UDID, and only application remote notifications are supported (no VoIP, complications, or File Provider pushes — a `simctl` limitation).

## The permission prerequisite (read this first)

iOS only shows a banner for an app whose **notification permission was granted**. `settings-permissions` cannot pre-grant notifications on iOS (notification authorization lives outside TCC), so the only path is the app's own permission dialog:

1. `launch-app` the target app.
2. If it shows the "… Would Like to Send You Notifications" dialog, `describe` → tap **Allow**.
3. If the app never asks (many test apps don't call the authorization API), a push is still _delivered_ to it, but **no banner appears** — you can only verify via the app's own behavior (badge, in-app state, logs).

A push to an app that never obtained permission is the #1 cause of "the tool returned delivered:true but I see nothing".

## Standard workflow: push → await banner → tap

1. Ensure the app is installed and has notification permission (above).
2. Send the app to the **background** — press home (`button` with `home`). A foregrounded app decides its own presentation (many suppress the banner); from the home screen you always get the classic banner.
3. Call the tool:

```json
{
  "udid": "<UDID>",
  "bundleId": "com.example.app",
  "title": "New message",
  "body": "Alice: are we still on for 12?",
  "badge": 1,
  "sound": "default"
}
```

4. Wait for the banner instead of polling screenshots: `await-ui-element` with `condition: "text"`, a selector matching the banner (e.g. `{ "text": "New message" }`), and `expectedText` from the title/body.
5. To open the app from it: `describe`, find the banner element's frame, `gesture-tap` its centre. Tapping the banner launches the app through its notification-tap path (deep link, userInfo handling) — exactly what a user tap does.
6. The banner auto-dismisses after ~5 s. If you missed it, it is still in Notification Center: swipe down from the top edge (`gesture-swipe` from y≈0.01 to y≈0.6), read/tap it there, then swipe up to close.

## Payload forms

- **Convenience fields** (`title`, `body`, `subtitle`, `badge`, `sound`) — the tool builds the APNS envelope for you. Provide at least `title` or `body`. `badge: 0` clears the badge; omit `sound` for a silent banner.
- **Raw `payload` object** — full APNS control, delivered verbatim: custom data keys the app reads in its handler, silent pushes (`{"aps":{"content-available":1}}`), mutable-content, category actions. Must contain a top-level `aps` key and fit in 4096 bytes. Mutually exclusive with the convenience fields.

Silent pushes (`content-available`, no alert) show nothing by design — verify through app behavior, not the screen.

## Errors and their fixes

- **"the app is not installed"** — wrong `bundleId` or the app isn't on this simulator. Install/launch it first; check the id for typos.
- **"current state: Shutdown" + boot hint** — the simulator isn't booted; run `boot-device`, then retry.
- **payload rejections** (no `aps` key, > 4096 bytes, payload + convenience fields together, nothing to deliver) — the error names the exact fix; correct the arguments rather than retrying.
- **`delivered: true` but no banner** — not an error: usually missing notification permission (see above), the app being foregrounded with a suppressing presentation handler, or a deliberately silent payload.

## Gotchas

- **Foreground ≠ background presentation.** A foregrounded app's `userNotificationCenter(_:willPresent:…)` decides whether anything shows. Background the app first unless you are specifically testing foreground presentation.
- **Verify with the UI, not just the result.** `delivered: true` means `simctl` accepted the push, not that a banner rendered. The follow-up screenshot (automatic) and `await-ui-element` are the oracle.
- **Notification interaction is ordinary UI.** The banner and Notification Center entries are visible to `describe` — never guess tap coordinates from a screenshot.
- **Repeated pushes stack.** Each call adds a Notification Center entry; use distinct titles/bodies per assertion so `await-ui-element` can't match a stale banner from an earlier push.
