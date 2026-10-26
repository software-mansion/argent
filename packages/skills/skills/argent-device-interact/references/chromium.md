# Chromium (CDP) Targets

Everything in the related SKILL.md still applies; this page covers what differs.

A Chromium (CDP) target is an Electron app or a Chromium-family browser (Chrome/Brave/Edge) exposing a Chrome DevTools Protocol endpoint. `describe`, `gesture-tap`, `keyboard` and `screenshot` work as on a phone. What differs:

- Scroll with `gesture-scroll` and drag with `gesture-drag`; `gesture-swipe` is touch-only.
- Tabs and windows: `chromium-tabs`. Every other tool acts on the **active** tab, so `select` before driving a different one. A cross-process navigation (some redirects) can swap a tab's CDP target; `list` again to pick it up under a fresh id.
- Cookies, HttpOnly included: `chromium-cookies`. Web Storage: `chromium-storage`. Use them to seed auth before an e2e test or assert app state after one.
