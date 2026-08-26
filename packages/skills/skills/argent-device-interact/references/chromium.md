# Chromium (CDP) Targets

Read this when your target is a Chromium device — `list-devices` tags it `platform: chromium` and its id is shaped `chromium-cdp-<port>`. Everything in SKILL.md still applies; this page covers what differs.

## What counts as a Chromium target

A **Chromium (CDP) app** = any Chromium runtime exposing a Chrome DevTools Protocol endpoint: an Electron app (boot it with `boot-device` + `electronAppPath`), or any Chromium-family browser (Chrome/Brave/Edge) launched with `--remote-debugging-port`. The latter is auto-discovered by `list-devices` on port `9222` plus anything in `ARGENT_CHROMIUM_PORTS` — already-running browsers show up directly, no `boot-device` needed. The same describe/tap/swipe/keyboard/screenshot surface drives all of them.

## Scrolling and dragging

`gesture-swipe` is **touch-only** and does not work here. Use these instead:

| Action | Tool             | Notes                                                            |
| ------ | ---------------- | ---------------------------------------------------------------- |
| Scroll | `gesture-scroll` | Wheel-based; deltas are window fractions, positive deltaY = down |
| Drag   | `gesture-drag`   | Sliders, drag-and-drop, text selection                           |

Both are allowed inside `run-sequence`.

## Multi-tab / windows

A Chromium device may have several tabs / BrowserWindows. Use `chromium-tabs` to `list` them (stable ids `t1`, `t2`, …, optional labels), open a `new` one, `select` which is active, or `close` one.

Every other tool (`describe`, `gesture-tap`, `screenshot`, `debugger-evaluate`, `open-url`, …) acts on the **active** tab, so `chromium-tabs action=select` before driving a different tab.

Note: a cross-process navigation (some redirects) can swap a tab's underlying CDP target — re-run `chromium-tabs action=list` to pick it up under a fresh id.

## Cookies & storage

`chromium-cookies` reads/writes cookies via the Network domain (so HttpOnly cookies are visible):

- `action=get` (optionally scoped by `url`)
- `set` (`name`, `value`, + `url`/`domain`, optional `secure`/`httpOnly`/`sameSite`/`expires`)
- `delete` (`name`)
- `clear` (all)

`chromium-storage` reads/writes Web Storage for the active page: `store=local|session`, `action=get` (one `key` or all entries), `set`, `remove`, `clear`.

Both are per-origin / active-tab. Handy for seeding auth before a flow or asserting app state after one.

## Other differences

- `paste` is **rejected** on Chromium — use `keyboard`.
- `keyboard`'s `delayMs` between keystrokes is honoured (as on the iOS simulator).
