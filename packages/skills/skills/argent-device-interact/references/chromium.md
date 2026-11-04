# Chromium (CDP) Targets

Everything in the related SKILL.md still applies; this page covers what differs.

## Web apps

To test a web app, `boot-device` with `browser: "chrome"` (or `chromium`, `edge`, `brave`; a missing one fails naming the installed ones), then `open-url` to the app's URL. Each boot starts a separate browser on a throwaway profile, so no cookies or logins carry over from the user's own browser or a previous boot; seed them with `chromium-cookies` / `chromium-storage`. On a host without a display, add `electronArgs: ["--headless=new"]`.

## Multi-tab / windows

A Chromium device may have several tabs / BrowserWindows. Use `chromium-tabs` to `list` them (stable ids `t1`, `t2`, …, optional labels), open a `new` one, `select` which is active, or `close` one.

Every other tool (`describe`, `gesture-tap`, `screenshot`, `debugger-evaluate`, `open-url`, …) acts on the **active** tab, so `chromium-tabs action=select` before driving a different tab.

Note: a cross-process navigation (some redirects) can swap a tab's underlying CDP target; re-run `chromium-tabs action=list` to pick it up under a fresh id.

## Cookies & storage

`chromium-cookies` reads/writes cookies via the Network domain (so HttpOnly cookies are visible):

- `action=get` (optionally scoped by `url`)
- `set` (`name`, `value`, + `url`/`domain`, optional `secure`/`httpOnly`/`sameSite`/`expires`)
- `delete` (`name`)
- `clear` (all)

`chromium-storage` reads/writes Web Storage for the active page: `store=local|session`, `action=get` (one `key` or all entries), `set`, `remove`, `clear`.

Both are per-origin / active-tab. Handy for seeding auth before an e2e test or asserting app state after one.
