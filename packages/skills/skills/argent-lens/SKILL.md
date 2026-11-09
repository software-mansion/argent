---
name: argent-lens
description: Propose multiple visual design variants for on-screen elements and let the human pick in the Argent Lens window. Use when the user asks for design alternatives / options / A-B choices for a screen or component, or any time you have produced more than one candidate look for an element and want a human decision before committing.
---

> **Prerequisite: feature flag.** This workflow is gated behind the `argent-lens` flag (off by default). Run `argent enable argent-lens` once before using it. If `propose_variant` comes back not-found, the flag is off; enable it and retry.

## 1. Overview

You implement several candidate designs, capture each one running on the device, and stage them with `propose_variant` (non-blocking, once per variant). The Argent Lens window opens on its own and shows each element as a card beside the live device stream; the human picks per element, may pin comments, and presses **Complete**. `await_user_selection` is the single blocking call that returns their decision. Both tools' descriptions cover their parameters and return shapes.

Resolve a simulator/emulator first (`argent-ios-simulator-setup` / `argent-android-emulator-setup`) and, for React Native, `argent-react-native-app-workflow` to run the app and reload the bundle.

## 2. Workflow

### Step 0: Plan the variants

Decide, before touching code, exactly which elements you are redesigning and the distinct variants for each. Write them down (e.g. "Search field: Filled / Outlined / Pill", "Primary CTA: Solid / Gradient"). Each variant must be a single, self-contained change you can apply, screenshot, and revert independently. Vague or overlapping variants produce useless proposals.

### Step 1: Get a precise matcher

For each element, run `describe` on its screen and read its exact `identifier` / `label` / `role`. Prefer `match: { by: "identifier", … }` (stable testID), then an exact `label`; the default `text` match is fine only when the element's visible text is unique. A wrong `match` makes the card point at the wrong element or float unanchored.

### Step 2: For each variant: build → navigate → screenshot → propose → revert

1. **Build the variant** in code.
2. **Apply it on the device.** Reload the RN bundle (`debugger-reload-metro`) or rebuild as needed so the running app shows this variant.
3. **Navigate to it** (`argent-device-interact`): a screenshot is only meaningful if the element is on screen.
4. **Screenshot.** Call `screenshot` and pass the returned path **straight through** as `variant.previewImage`. **NEVER hand-crop, resize, re-encode, or copy the screenshot to another folder**: that double-crops against the preview window's own cropping and writes the image where the server won't serve it ("No preview"). If you suspect the variant didn't apply (no visible change vs. the previous capture), compare with the previous path (`shasum -a 256`): byte-identical captures mean the variant is not on screen yet. Fix that; never propose anyway.
5. **Propose** with `element`, `match`, `udid` (the device you captured on) and `previewImage`, plus a `summary` and `code`/`filePath` when useful. The tool **auto-captures the crop frame** by describing the device at propose time, so propose right after the screenshot, while the variant is still on screen. Pass `variant.frame` only to override that, e.g. when the element can't stay on screen at propose time.
6. **Revert** the change before building the next variant.

### Step 3: Await the human's decision

After every variant for every element is staged, call `await_user_selection` once. A `pending` result is normal: the proposals stay live, call it again. In an `argent lens` session that tool is hidden: end your turn instead, and the user's choice arrives as a message.

### Step 4: Apply the outcome

Implement the chosen variant for every selected element, treat every annotation and the global comment as a change request, and report what you applied and what was skipped. If the human commented but skipped a variant, the comment still matters; act on it.

## 3. Rules

- **One variant = one real, _distinct_ screenshot.** Every `previewImage` must show that variant actually running on the device, captured after it was applied: no mockups, no un-built ideas, never the same path (or byte-identical captures) for two variants. If you can't produce visibly different captures (the app is read-only, accessibility is broken so you can't navigate, the bundle won't hot-reload), STOP and tell the user instead of staging duplicates.
- **At least two variants per element.** If you only have one look for an element, produce a real alternative or don't propose that element at all; a lone variant isn't a choice.
- **One variant on screen at a time.** Apply → screenshot → propose → revert, so screenshots never bleed together.
- **Re-proposing starts a fresh round.** Calling `propose_variant` after a round was consumed begins the next round and clears the previous round's elements; stage a full set each round.
