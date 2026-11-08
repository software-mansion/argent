# Chromium (CDP) Targets

Everything in the related SKILL.md still applies; this page covers what differs.

A Chromium (CDP) target is an Electron app or a Chromium-family browser (Chrome/Brave/Edge) exposing a Chrome DevTools Protocol endpoint. `describe`, `gesture-tap`, `keyboard` and `screenshot` work as on a phone. What differs:

- Scroll with `gesture-scroll` and drag with `gesture-drag`; `gesture-swipe` is touch-only.
- The tree leaves out rows outside the window: `[scrollHidden=N(below)]` on a parent counts them and names the sides they lie on (`above`, `below`, `left`, `right`). Scroll toward that side; `gesture-scroll` does not bring in a skip link parked off the page or a closed off-canvas drawer. `await-ui-element` with `exists` still finds a row the tree leaves out, so it can tell you whether something is further along; `visible` means it is in the window, and `hidden` also passes for a row that is only scrolled away.
- Tabs and windows: `chromium-tabs`. Every other tool acts on the **active** tab, so `select` before driving a different one. A cross-process navigation (some redirects) can swap a tab's CDP target; `list` again to pick it up under a fresh id.
- Cookies, HttpOnly included: `chromium-cookies`. Web Storage: `chromium-storage`. Use them to seed auth before an e2e test or assert app state after one.
