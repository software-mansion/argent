---
name: argent-screenshot-diff
description: Compare saved or live app screenshots with the argent screenshot-diff tool. Use when testing visual regressions, before/after UI comparisons, screenshot diff checks, visible layout, spacing, color, typography, clipping, overflow, text rendering, or image/icon rendering changes.
---

## 1. Role

Use `screenshot-diff` as supporting visual evidence for UI QA and visual regression checks. It highlights pixel-visible change or stability; it does not replace visual inspection, accessibility/component-tree state, frame/attribute checks, logs, network evidence, or app behavior.

Do not use screenshot diffing for tap-coordinate discovery. Use `describe`, `debugger-component-tree`, or `native-describe-screen` to find targets first.

## 2. When To Use

Use `screenshot-diff` when pixel comparison can answer the verification question:

- Required for explicit "UI regression test", "visual regression test", "screenshot diff", "compare screenshots", or "before/after visual comparison" requests, unless stable comparable screenshots cannot be produced.
- Good fit when the affected screen has stable before/after states and the expected result is pixel-visible: layout, position, size, spacing, color, typography, image/icon rendering, clipping, overflow, or text rendering.
- Good fit when the risk is unintended visual regression outside the exact element changed.
- Poor fit when the result is better verified structurally: state changes, navigation existence, accessibility tree contents, console/network behavior, or unit tests.
- Poor fit when dynamic content, unpausable animation, timestamps, ads, random data, or missing baseline/current screenshots would make the comparison noisy or meaningless.

## 3. Capture Rules

Use normal downscaled `screenshot` calls for UI context and state checks. Use full-resolution screenshots only when saving baseline/current PNG files for visual regression comparison. Suppress the image block on those baseline captures, whatever scale they end up at, so the PNG is saved without being loaded into context:

```json
{ "udid": "<UDID>", "scale": 1.0, "includeImageInContext": false }
```

Some Android emulators cannot stream a full-resolution frame and reject `scale: 1.0` with a `wrong data size` error. Omit `scale` on those devices: `screenshot-diff` falls back to that same scale whenever its own full-resolution capture fails, so the two sides usually match and nothing is resampled. Both lose that fallback when `ARGENT_SCREENSHOT_SCALE` is 1.0, where an omitted `scale` is the rejected request again: save both sides with `screenshot` at the same explicit scale and pass the paths, rather than capturing live. They can still differ — the fallback fires on any capture failure, not only this one, and the tool-server's screenshot scale may change between the two captures — which the summary discloses as `size_normalized`. Treat a `resized_no_change` result as weaker evidence than an unnormalized one: the downscale can erase a difference as well as invent one.

Capture the stable baseline before the relevant interaction or before editing whenever feasible. Compare it to the post-change or post-interaction screen after the app reloads, rebuilds, or reaches the state under test.

## 4. Parameters

Provide `udid` and exactly one input for the baseline side and exactly one input for the current side:

- Common UI regression flow: saved baseline plus live current -> `baselinePath`, `captureCurrent: true`, `udid`, `outputDir`.
- Both screenshots already saved -> `baselinePath`, `currentPath`, `udid`, `outputDir`.
- Rare fixture flow: live baseline plus saved current -> `captureBaseline: true`, `currentPath`, `udid`, `outputDir`.
- Do not combine `captureBaseline: true` with `captureCurrent: true`, or provide both a path and live capture flag for the same side.

## 5. Deterministic Flow

1. Navigate to the known-good state.
2. Capture a baseline PNG with `screenshot` per the capture rules above and `includeImageInContext: false`; keep the returned `path`.
3. Perform the interaction, apply the code change and navigate to the state under test.
4. Call `screenshot-diff` with the saved `baselinePath`, `captureCurrent: true`, `udid`, and `outputDir`.
5. Inspect the summary and artifact paths, then combine the diff with normal visual inspection and any structural/runtime evidence needed for the assertion.

```json
{
  "baselinePath": "/tmp/baseline.png",
  "captureCurrent": true,
  "udid": "<UDID>",
  "outputDir": "/tmp/argent-diff"
}
```

If both images are already saved, use file paths for both sides:

```json
{
  "baselinePath": "/tmp/baseline.png",
  "currentPath": "/tmp/current.png",
  "udid": "<UDID>",
  "outputDir": "/tmp/argent-diff"
}
```
