---
name: argent-propose-variants
description: Propose multiple visual design variants for on-screen elements and let the human pick in the Argent preview UI. Use when the user asks for design alternatives / options / A-B choices for a screen or component, or any time you have produced more than one candidate look for an element and want a human decision before committing.
---

## 1. Overview

You implement several candidate designs, capture each one running on the device, and stage them with `propose_variant`. Each proposed element shows up as a floating card next to the live simulator stream in the Argent preview UI, connected by a thin line to the real element. The human picks per element, optionally pins free-form comments to elements, and presses **Complete selection**. `await_user_selection` is the single blocking call that returns their decision.

**The golden rule: one variant = one real screenshot.** A proposal is only useful if its `previewImage` shows the variant actually rendered on the device. Never propose a variant you have not built and seen on screen. Plan → build → navigate → screenshot → propose, repeated for every variant of every element, then await once.

## 2. Tools

| Tool                   | Blocking? | Purpose                                                                 |
| ---------------------- | --------- | ----------------------------------------------------------------------- |
| `propose_variant`      | No        | Stage ONE variant for ONE element. Call once per variant. Keep working. |
| `await_user_selection` | Yes       | Call ONCE after every variant is staged. Parks until the human is done. |

`propose_variant` params: `element` (human name), optional `match` (`{ by: "text"|"label"|"identifier"|"role", value }`), and `variant` (`{ name, summary, code?, filePath?, previewImage? }`). Repeated calls with the same `element` accumulate variants on that element; different `element` values create separate cards.

## 3. Workflow

Resolve a simulator/emulator first (`argent-ios-simulator-setup` / `argent-android-emulator-setup`) and, for React Native, `argent-react-native-app-workflow` to run the app and reload the bundle. The human opens the preview UI the tool-server serves (`/preview/`); you do not launch a browser.

### Step 0 — Plan the variants

Decide, before touching code, exactly which elements you are redesigning and the distinct variants for each. Write them down (e.g. "Search field: Filled / Outlined / Pill" — "Primary CTA: Solid / Gradient"). Each variant must be a single, self-contained change you can apply, screenshot, and revert independently. Vague or overlapping variants produce useless proposals.

### Step 1 — Get a precise matcher

For each element, run `describe` (or `debugger-component-tree` for RN) on the screen where it lives and read its exact `label` / `identifier` / `role`. Pass that as `match` so the floating card's connector anchors to the right element:

- Stable testID / accessibilityIdentifier → `{ by: "identifier", value: "search-input" }` (most reliable)
- Exact a11y label → `{ by: "label", value: "Search" }`
- Otherwise → `{ by: "text", value: "Search" }` (fuzzy contains; the default if `match` is omitted)

Omitting `match` defaults to `{ by: "text", value: element }`, which is fine only when the element's visible text is unique.

### Step 2 — For each variant: build → navigate → screenshot → propose

Loop over every variant of every element:

1. **Build the variant.** Implement that one variant in code.
2. **Apply it on the device.** Reload the RN bundle (`debugger-reload-metro`) or rebuild as needed so the running app shows this variant.
3. **Navigate to it.** Drive the app (`argent-device-interact`) to the screen where the element is visible — a screenshot is only meaningful if the element is actually on screen.
4. **Screenshot.** Call `screenshot`; keep the returned file path. The preview UI auto-crops the image to the element's box using `match`, so capture the whole screen — do not hand-crop.
5. **Propose.** Call `propose_variant` with `element`, `match`, and `variant.previewImage` set to that screenshot path. Add `summary` (what changed and why) and `code`/`filePath` when useful.
6. **Revert.** Roll the variant change back before building the next one — only one variant can be on screen at a time. Keep going; `propose_variant` does not block.

`previewImage` accepts a local screenshot path (served from the OS temp dir / cwd), an `http(s)` URL, or a `data:` URI. A local screenshot of the real running variant is strongly preferred.

### Step 3 — Await the human's decision (once)

After every variant for every element is staged, call `await_user_selection` exactly once. It returns:

- `{ status: "completed", selections: [{ element, chosenVariant, comment? }], unselected, annotations: [{ target, match, comment }], globalComment }` — apply `chosenVariant` for each element; skip elements in `unselected`. Treat each `annotations` entry (inspector comments the human pinned to elements) and `globalComment` as a change request.
- `{ status: "pending", proposedElements }` — `timeoutSeconds` elapsed, not an error. Proposals are still live; call `await_user_selection` again.
- `{ status: "no_proposals" }` — you called it before any `propose_variant`. Stage variants first.

### Step 4 — Apply the outcome

Implement the chosen variant for every selected element, address every annotation/comment, and report what you applied and what was skipped. If the human commented but skipped a variant, the comment still matters — act on it.

## 4. Rules

- **Build before you propose.** Every `previewImage` must be a screenshot of that variant actually running on the device. No mockups, no guesses, no proposing un-built ideas.
- **One blocking call.** `propose_variant` never blocks — stage freely. `await_user_selection` is the only call that waits, and you call it once, last.
- **Anchor accurately.** Pull matchers from `describe`; a wrong `match` makes the card point at the wrong element or float unanchored.
- **One variant on screen at a time.** Apply → screenshot → revert before the next variant so screenshots never bleed together.
- **`pending` is normal.** On `pending`, just await again — proposals persist across timeouts.
- **Re-proposing starts a fresh round.** Calling `propose_variant` after a round was consumed begins round N+1 and clears the previous round's elements; stage a full set each round.

## 5. Example

```
describe { udid }                                  # read exact label/identifier
propose_variant { element: "Search field",
  match: { by: "identifier", value: "search-input" },
  variant: { name: "Outlined", summary: "1pt border, transparent fill",
             previewImage: "/var/folders/.../search-outlined.png" } }
propose_variant { element: "Search field",
  match: { by: "identifier", value: "search-input" },
  variant: { name: "Pill", summary: "Fully rounded, filled grey",
             previewImage: "/var/folders/.../search-pill.png" } }
propose_variant { element: "Primary CTA",
  match: { by: "label", value: "Get started" },
  variant: { name: "Gradient", summary: "Accent gradient fill",
             previewImage: "/var/folders/.../cta-gradient.png" } }
await_user_selection {}                             # ONE blocking call → human picks
→ { status: "completed",
    selections: [ { element: "Search field", chosenVariant: { name: "Pill" } },
                  { element: "Primary CTA",  chosenVariant: { name: "Gradient" } } ],
    annotations: [ { target: "Tab bar", comment: "raise contrast" } ] }
# → apply Pill + Gradient, and raise tab-bar contrast.
```
